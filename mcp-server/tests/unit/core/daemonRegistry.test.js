import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getDaemonRegistryPath,
  getDaemonLockPath,
  getDaemonLogPath,
  isProcessAlive,
  readDaemonRegistry,
  removeDaemonRegistry,
  writeDaemonRegistry
} from '../../../src/core/daemonRegistry.js';

describe('daemon registry', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-daemon-registry-'));
    tempDirs.push(dir);
    return dir;
  }

  it('writes and reads daemon registry state from the configured directory', async () => {
    const registryDir = await makeTempDir();

    await writeDaemonRegistry({
      registryDir,
      port: 49152,
      pid: process.pid,
      url: 'http://127.0.0.1:49152/mcp',
      packageVersion: '1.4.0',
      gitHead: 'abc123',
      entrypoint: '/repo/mcp-server/src/core/server.js',
      nodeVersion: 'v22.0.0',
      selectedUnity: {
        pid: 123,
        port: 6400,
        projectPath: '/tmp/project'
      }
    });

    const registry = await readDaemonRegistry({ registryDir });

    assert.equal(registry.pid, process.pid);
    assert.equal(registry.port, 49152);
    assert.equal(registry.url, 'http://127.0.0.1:49152/mcp');
    assert.equal(registry.packageVersion, '1.4.0');
    assert.equal(registry.version, '1.4.0');
    assert.equal(registry.gitHead, 'abc123');
    assert.equal(registry.entrypoint, '/repo/mcp-server/src/core/server.js');
    assert.equal(registry.nodeVersion, 'v22.0.0');
    assert.equal(registry.selectedUnity.projectPath, '/tmp/project');
    assert.match(registry.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(registry.lastSeen, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(getDaemonRegistryPath({ registryDir })), true);
  });

  it('returns null for a missing daemon registry', async () => {
    const registryDir = await makeTempDir();

    assert.equal(await readDaemonRegistry({ registryDir }), null);
  });

  it('removes only the configured daemon registry file', async () => {
    const registryDir = await makeTempDir();
    const unrelatedPath = path.join(registryDir, 'instances', '123.json');
    await fsp.mkdir(path.dirname(unrelatedPath), { recursive: true });
    await fsp.writeFile(unrelatedPath, '{}');
    await writeDaemonRegistry({ registryDir, port: 49152, pid: process.pid });

    await removeDaemonRegistry({ registryDir });

    assert.equal(fs.existsSync(getDaemonRegistryPath({ registryDir })), false);
    assert.equal(fs.existsSync(unrelatedPath), true);
  });

  it('detects live and dead pids without throwing', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(null), false);
  });

  it('returns daemon lock and log paths in the configured registry directory', async () => {
    const registryDir = await makeTempDir();

    assert.equal(getDaemonLockPath({ registryDir }), path.join(registryDir, 'daemon.lock'));
    assert.equal(getDaemonLogPath({ registryDir }), path.join(registryDir, 'daemon.log'));
  });
});
