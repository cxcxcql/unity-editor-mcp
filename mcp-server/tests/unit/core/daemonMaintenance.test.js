import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { cleanupStaleDaemon, createDaemonStatusReport, probeTcpEndpoint } from '../../../src/core/daemonMaintenance.js';
import { getDaemonLockPath, readDaemonRegistry, writeDaemonRegistry } from '../../../src/core/daemonRegistry.js';

describe('daemon maintenance', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-daemon-maintenance-'));
    tempDirs.push(dir);
    return dir;
  }

  it('removes dead daemon registry state without touching live registries', async () => {
    const registryDir = await makeTempDir();
    await writeDaemonRegistry({ registryDir, pid: 99999999, port: 49152 });

    const result = await cleanupStaleDaemon({ registryDir });

    assert.equal(result.removedRegistry, true);
    assert.equal(result.killedProcess, false);
    assert.equal(await readDaemonRegistry({ registryDir }), null);
  });

  it('removes stale daemon locks during cleanup', async () => {
    const registryDir = await makeTempDir();
    const lockPath = getDaemonLockPath({ registryDir });
    await fsp.writeFile(lockPath, JSON.stringify({
      pid: 99999999,
      createdAt: new Date(Date.now() - 60000).toISOString()
    }));

    const result = await cleanupStaleDaemon({
      registryDir,
      staleAfterMs: 100
    });

    assert.equal(result.removedLock, true);
    await assert.rejects(fsp.stat(lockPath), { code: 'ENOENT' });
  });

  it('kills duplicate known daemon processes but ignores unrelated Node processes', async () => {
    const registryDir = await makeTempDir();
    await writeDaemonRegistry({
      registryDir,
      pid: 4100,
      port: 49152,
      lastSeen: new Date().toISOString()
    });
    const killed = [];

    const result = await cleanupStaleDaemon({
      registryDir,
      staleAfterMs: 30000,
      healthTimeoutMs: 1,
      isProcessAlive: (pid) => [4100, 4101, 4102, 4103].includes(Number(pid)),
      getProcessCommand: async (pid) => {
        if (pid === 4100) {
          return `node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir ${registryDir}`;
        }
        if (pid === 4101) {
          return `node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir ${registryDir}`;
        }
        return 'node unrelated.js';
      },
      getProcessList: async () => [
        { pid: 4100, command: `node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir ${registryDir}` },
        { pid: 4101, command: `node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir ${registryDir}` },
        { pid: 4102, command: 'node unrelated.js' },
        { pid: 4103, command: 'node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir /tmp/other-registry' }
      ],
      killProcess: async (pid) => killed.push(pid)
    });

    assert.deepEqual(killed, [4101]);
    assert.deepEqual(result.killedDuplicatePids, [4101]);
    assert.equal(result.duplicateDaemons.length, 1);
    assert.equal(result.duplicateDaemons[0].pid, 4101);
  });

  it('stops only a stale registry-validated Unity MCP daemon process', async () => {
    const registryDir = await makeTempDir();
    let alive = true;
    let killedPid = null;
    await writeDaemonRegistry({
      registryDir,
      pid: 4242,
      port: 49153,
      lastSeen: new Date(Date.now() - 60000).toISOString()
    });

    const result = await cleanupStaleDaemon({
      registryDir,
      staleAfterMs: 100,
      healthTimeoutMs: 10,
      isProcessAlive: () => alive,
      getProcessList: async () => [],
      getProcessCommand: async () => `node /repo/mcp-server/src/core/server.js daemon --daemon-registry-dir ${registryDir}`,
      killProcess: async (pid) => {
        killedPid = pid;
        alive = false;
      }
    });

    assert.equal(result.killedProcess, true);
    assert.equal(result.removedRegistry, true);
    assert.equal(killedPid, 4242);
    assert.equal(await readDaemonRegistry({ registryDir }), null);
  });

  it('does not kill an unrelated process even when a registry is stale', async () => {
    const registryDir = await makeTempDir();
    let killed = false;
    await writeDaemonRegistry({
      registryDir,
      pid: 4243,
      port: 49154,
      lastSeen: new Date(Date.now() - 60000).toISOString()
    });

    const result = await cleanupStaleDaemon({
      registryDir,
      staleAfterMs: 100,
      healthTimeoutMs: 10,
      isProcessAlive: () => true,
      getProcessList: async () => [],
      getProcessCommand: async () => 'node some-other-server.js',
      killProcess: async () => {
        killed = true;
      }
    });

    assert.equal(result.killedProcess, false);
    assert.equal(result.removedRegistry, false);
    assert.equal(killed, false);
    assert.ok(await readDaemonRegistry({ registryDir }));
  });

  it('reports daemon, shim, and Unity listener layers', async () => {
    const registryDir = await makeTempDir();
    await writeDaemonRegistry({
      registryDir,
      pid: process.pid,
      port: 49152,
      selectedUnity: {
        pid: 123,
        port: 6400,
        projectPath: '/tmp/unity-project'
      }
    });

    const report = await createDaemonStatusReport({
      registryDir,
      shimTransportClosed: true,
      unityReport: {
        status: 'ok',
        selected: {
          projectPath: '/tmp/unity-project'
        }
      }
    });

    assert.equal(report.layers.stdioShim.status, 'transport_closed');
    assert.equal(report.layers.daemon.status, 'ok');
    assert.equal(report.layers.unityListener.status, 'ok');
    assert.match(report.recommendations.join('\\n'), /cleanup-stale|daemon/);
  });

  it('probes whether a Unity listener endpoint accepts TCP connections', async () => {
    const tcpServer = net.createServer((socket) => socket.end());
    await new Promise((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));

    try {
      const open = await probeTcpEndpoint({
        host: '127.0.0.1',
        port: tcpServer.address().port
      });
      const closed = await probeTcpEndpoint({
        host: '127.0.0.1',
        port: 1
      }, {
        timeoutMs: 10
      });

      assert.equal(open.ok, true);
      assert.equal(closed.ok, false);
    } finally {
      await new Promise((resolve) => tcpServer.close(resolve));
    }
  });
});
