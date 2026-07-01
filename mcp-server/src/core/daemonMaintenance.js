import { getDaemonHealth } from './daemonClient.js';
import fsp from 'fs/promises';
import net from 'net';
import {
  getDaemonLockPath,
  isRegistryFresh,
  isProcessAlive,
  readDaemonRegistry,
  removeDaemonRegistry,
  summarizeDaemonRegistry
} from './daemonRegistry.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function cleanupStaleDaemon(options = {}) {
  const registry = await readDaemonRegistry(options);
  const lockCleanup = await cleanupDaemonLock(options);
  const duplicateCleanup = await cleanupDuplicateDaemonProcesses(registry, options);
  const cleanupContext = {
    ...lockCleanup,
    ...duplicateCleanup
  };

  if (!registry) {
    return {
      ...cleanupContext,
      removedRegistry: false,
      killedProcess: false,
      message: 'No daemon registry found.'
    };
  }

  const processAlive = options.isProcessAlive || isProcessAlive;
  if (!processAlive(registry.pid)) {
    await removeDaemonRegistry(options);
    return {
      ...cleanupContext,
      removedRegistry: true,
      killedProcess: false,
      pid: registry.pid,
      message: 'Removed stale daemon registry for dead process.'
    };
  }

  const health = await getDaemonHealth(registry, { timeoutMs: options.healthTimeoutMs || 1000 });
  if (health) {
    return {
      ...cleanupContext,
      removedRegistry: false,
      killedProcess: false,
      pid: registry.pid,
      message: 'Daemon is alive; nothing cleaned.'
    };
  }

  const fresh = isRegistryFresh(registry, options.staleAfterMs ?? 30000);
  if (fresh) {
    return {
      ...cleanupContext,
      removedRegistry: false,
      killedProcess: false,
      pid: registry.pid,
      message: 'Daemon process is alive and registry is fresh, but health check failed; not killing.'
    };
  }

  const command = await getProcessCommand(registry.pid, options);
  if (!isKnownUnityMcpDaemonCommand(command, options)) {
    return {
      ...cleanupContext,
      removedRegistry: false,
      killedProcess: false,
      pid: registry.pid,
      command,
      message: 'Daemon registry is stale, but the pid does not look like a Unity MCP daemon; not killing.'
    };
  }

  await killProcess(registry.pid, options);
  const exited = await waitForProcessExit(registry.pid, processAlive, options.processExitTimeoutMs ?? 1500);
  if (exited) {
    await removeDaemonRegistry(options);
    return {
      ...cleanupContext,
      removedRegistry: true,
      killedProcess: true,
      pid: registry.pid,
      command,
      message: 'Stopped stale Unity MCP daemon and removed its registry.'
    };
  }

  return {
    ...cleanupContext,
    removedRegistry: false,
    killedProcess: false,
    pid: registry.pid,
    command,
    message: 'Stale Unity MCP daemon did not exit after SIGTERM; registry left in place.'
  };
}

export async function createDaemonStatusReport(options = {}) {
  const registry = await readDaemonRegistry(options);
  const daemonSummary = summarizeDaemonRegistry(registry, {
    staleAfterMs: options.staleAfterMs
  });
  const health = registry && isProcessAlive(registry.pid)
    ? await getDaemonHealth(registry, { timeoutMs: options.healthTimeoutMs || 1000 })
    : null;
  const unityReport = options.unityReport || null;
  const stdioShimStatus = options.shimTransportClosed ? 'transport_closed' : 'unknown';
  const recommendations = [];

  if (stdioShimStatus === 'transport_closed') {
    recommendations.push('Hosted stdio transport is closed; restart the MCP client/session or use daemon-backed stdio shim.');
  }

  if (daemonSummary.status !== 'ok' && !health) {
    recommendations.push('Run `unity-editor-mcp cleanup-stale`, then call any tool again to auto-start the daemon.');
  }

  if (!unityReport || unityReport.status !== 'ok') {
    recommendations.push('Open the target Unity project and confirm the Unity Editor MCP package is installed and registered.');
  }

  if (recommendations.length === 0) {
    recommendations.push('All MCP layers look healthy.');
  }

  return {
    layers: {
      stdioShim: {
        status: stdioShimStatus,
        message: stdioShimStatus === 'transport_closed'
          ? 'Codex/client stdio wrapper reported Transport closed.'
          : 'No stdio transport error was provided to doctor.'
      },
      daemon: {
        ...daemonSummary,
        status: health ? 'ok' : daemonSummary.status,
        health
      },
      unityListener: unityReport || {
        status: 'unknown',
        message: 'Unity listener discovery was not supplied.'
      }
    },
    recommendations
  };
}

async function cleanupDaemonLock(options = {}) {
  const lockPath = getDaemonLockPath(options);
  let lock;
  try {
    lock = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        removedLock: false,
        lockPath
      };
    }
    lock = null;
  }

  const processAlive = options.isProcessAlive || isProcessAlive;
  const createdAtMs = Date.parse(lock?.createdAt);
  const tooOld = !Number.isFinite(createdAtMs) ||
    Date.now() - createdAtMs > (options.staleAfterMs ?? 30000);
  const deadOwner = !processAlive(lock?.pid);
  if (!tooOld && !deadOwner) {
    return {
      removedLock: false,
      lockPath
    };
  }

  await fsp.rm(lockPath, { force: true });
  return {
    removedLock: true,
    lockPath
  };
}

async function cleanupDuplicateDaemonProcesses(registry, options = {}) {
  const processes = await listProcessCommands(options);
  const registeredPid = Number(registry?.pid);
  const duplicates = processes.filter((processInfo) =>
    Number(processInfo.pid) !== registeredPid &&
    isKnownUnityMcpDaemonCommand(processInfo.command, options)
  );
  const killedDuplicatePids = [];

  for (const processInfo of duplicates) {
    await killProcess(processInfo.pid, options);
    killedDuplicatePids.push(Number(processInfo.pid));
  }

  return {
    duplicateDaemons: duplicates.map((processInfo) => ({
      pid: Number(processInfo.pid),
      command: processInfo.command
    })),
    killedDuplicatePids
  };
}

async function listProcessCommands(options = {}) {
  if (typeof options.getProcessList === 'function') {
    return options.getProcessList();
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 1000
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        return match
          ? { pid: Number(match[1]), command: match[2] }
          : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function probeTcpEndpoint(endpoint, options = {}) {
  if (!endpoint?.host || !endpoint?.port) {
    return {
      ok: false,
      error: 'Missing endpoint host or port'
    };
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeoutMs = options.timeoutMs ?? 500;
    let resolved = false;

    const finish = (result) => {
      if (resolved) {
        return;
      }
      resolved = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: `Timed out after ${timeoutMs}ms` }));
    socket.once('error', (error) => finish({ ok: false, error: error.message, code: error.code }));
    socket.connect(Number(endpoint.port), endpoint.host);
  });
}

export async function getProcessCommand(pid, options = {}) {
  if (typeof options.getProcessCommand === 'function') {
    return options.getProcessCommand(pid);
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1000
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export function isKnownUnityMcpDaemonCommand(command, options = {}) {
  if (!command || typeof command !== 'string') {
    return false;
  }

  const normalized = command.replaceAll('\\ ', ' ');
  const registryDir = options.registryDir ? String(options.registryDir) : null;
  const looksLikeUnityMcp = normalized.includes('unity-editor-mcp') ||
    normalized.includes('/src/core/server.js') ||
    normalized.includes('mcp-server/src/core/server.js');
  const isDaemon = /\bdaemon\b/.test(normalized);
  const registryMatches = !registryDir || normalized.includes(registryDir);

  return looksLikeUnityMcp && isDaemon && registryMatches;
}

async function killProcess(pid, options = {}) {
  if (typeof options.killProcess === 'function') {
    return options.killProcess(pid);
  }

  process.kill(Number(pid), 'SIGTERM');
}

async function waitForProcessExit(pid, processAlive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !processAlive(pid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
