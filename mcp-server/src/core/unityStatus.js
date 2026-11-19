import { execFile } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import {
  getDefaultRegistryDir,
  isProcessAlive,
  normalizeProjectPath,
  readUnityInstances,
  selectUnityInstance
} from './unityDiscovery.js';

const execFileAsync = promisify(execFile);
const pendingStartTimeChecks = new Map();
const FRESH_AFTER_MS = 15000;
const RETRY_AFTER_MS = 5000;
const MAX_ACTIVE_AGE_MS = {
  compiling: 30 * 60 * 1000,
  building: 30 * 60 * 1000,
  reloading: 120000
};
const STATE_TEXT = {
  ready: 'Unity 编辑器可接收命令',
  compiling: 'Unity 正在编译脚本',
  building: 'Unity 正在构建',
  reloading: 'Unity 正在重载脚本域',
  unresponsive: '当前无法确认 Unity 编辑器可接收命令',
  offline: '未发现匹配的 Unity 编辑器'
};

// Status uses the local registry and activity snapshots, independently of the editor TCP connection.
export async function getUnityStatus(unityConfig = {}, endpoint = null) {
  const observedAt = new Date();
  const discovery = unityConfig.discovery || {};
  if (discovery.enabled === false) {
    return withoutSnapshot('unresponsive', observedAt);
  }

  const registryDir = discovery.registryDir || getDefaultRegistryDir();
  const activityDir = discovery.activityDir || path.join(path.dirname(registryDir), 'activity');
  const [instances, snapshots] = await Promise.all([
    readUnityInstances({ registryDir, includeStale: true }),
    readActivitySnapshots(activityDir)
  ]);

  // Keep legacy registrations visible, but only a matching activity snapshot can establish a busy phase.
  const candidates = new Map();
  for (const instance of instances) {
    if (isEditor(instance) && instance.alive) {
      candidates.set(instance.pid, { ...instance, staleExactMatch: instance.stale, registration: instance });
    }
  }
  for (const snapshot of snapshots) {
    if (!isEditor(snapshot) || !isProcessAlive(snapshot.pid)) {
      continue;
    }
    const registration = candidates.get(snapshot.pid)?.registration;
    const normalizedProjectPath = normalizeProjectPath(snapshot.projectPath);
    if (registration && (
      !sameProjectPath(normalizedProjectPath, registration.normalizedProjectPath) ||
      registration.workspaceId !== snapshot.workspaceId ||
      (registration.processStartedAt && registration.processStartedAt !== snapshot.processStartedAt)
    )) {
      continue;
    }

    candidates.set(snapshot.pid, {
      ...snapshot,
      registration,
      snapshot,
      normalizedProjectPath,
      stale: false,
      alive: true
    });
  }

  let matching = [...candidates.values()];
  if (unityConfig.hasExplicitPort) {
    matching = matching.filter((instance) =>
      [instance.port, instance.registration?.port].some((port) => Number(port) === Number(unityConfig.port)) &&
      localHost(instance.host) === localHost(unityConfig.host)
    );
  }
  matching.sort((left, right) =>
    Date.parse(right.updatedAt || right.lastSeen) - Date.parse(left.updatedAt || left.lastSeen)
  );

  let instance = null;
  while (matching.length > 0) {
    try {
      const bound = endpoint?.instance;
      const currentRegistration = discovery.instanceId
        ? matching.find((candidate) => candidate.registration?.instanceId === discovery.instanceId)
        : null;
      instance = matching.find((candidate) =>
        bound?.pid === candidate.pid &&
        sameProjectPath(bound.normalizedProjectPath || normalizeProjectPath(bound.projectPath), candidate.normalizedProjectPath) &&
        (!bound.processStartedAt || bound.processStartedAt === candidate.processStartedAt)
      ) || selectUnityInstance(matching, {
        instanceId: currentRegistration?.instanceId || discovery.instanceId,
        projectPath: discovery.projectPath,
        workspaceId: discovery.workspaceId,
        cwd: discovery.cwd || process.cwd(),
        allowSingleInstanceFallback: unityConfig.hasExplicitPort || discovery.allowSingleInstanceFallback
      })?.instance;
    } catch (error) {
      const noMatch = error.code === 'NO_UNITY_INSTANCE' || error.code === 'LOCAL_WORKSPACE_MISMATCH';
      return withoutSnapshot(noMatch && !unityConfig.hasExplicitPort ? 'offline' : 'unresponsive', observedAt);
    }
    if (!instance) {
      break;
    }

    const expectedStart = Date.parse(instance.processStartedAt);
    if (Number.isFinite(expectedStart)) {
      const actualStart = await getProcessStartTime(instance.pid);
      if (!Number.isFinite(actualStart) && isProcessAlive(instance.pid)) {
        return {
          ...withoutSnapshot('unresponsive', observedAt, instance, true),
          identityVerified: false,
          lastKnownActivity: instance.snapshot ? activityFields(instance) : null
        };
      }
      // Windows supplies millisecond precision. ps supplies whole seconds.
      const toleranceMs = process.platform === 'win32' ? 1 : 1000;
      if (!Number.isFinite(actualStart) || Math.abs(actualStart - expectedStart) > toleranceMs) {
        matching = matching.filter((candidate) => candidate !== instance);
        instance = null;
        continue;
      }
    }
    break;
  }

  if (!instance) {
    // Explicit ports may refer to legacy or remote editors without an activity file.
    return withoutSnapshot(unityConfig.hasExplicitPort ? 'unresponsive' : 'offline', observedAt);
  }
  if (!instance.snapshot) {
    return withoutSnapshot('unresponsive', observedAt, instance, instance.activityTracking === true);
  }

  const ageMs = Math.max(0, observedAt.getTime() - Date.parse(instance.updatedAt));
  const fresh = ageMs <= FRESH_AFTER_MS;
  const current = fresh || ageMs <= (MAX_ACTIVE_AGE_MS[instance.state] || 0);
  const state = current ? instance.state : 'unresponsive';
  const lastKnownActivity = fresh ? null : activityFields(instance);

  return {
    ...identityFields(instance),
    state,
    message: fresh
      ? STATE_TEXT[state]
      : `最后已知活动：${STATE_TEXT[instance.state]}，状态快照已超过心跳时限`,
    source: current ? instance.source : null,
    updatedAt: instance.updatedAt,
    activityStartedAt: instance.activityStartedAt,
    observedAt: observedAt.toISOString(),
    ageMs,
    freshness: fresh ? 'fresh' : 'stale',
    lastKnownActivity,
    activityTracking: true,
    identityVerified: true,
    ...(state !== 'ready' && { retryAfterMs: RETRY_AFTER_MS })
  };
}

export function createUnityBusyError(status) {
  const identityUnverified = status?.identityVerified === false;
  if (!identityUnverified && !Object.hasOwn(MAX_ACTIVE_AGE_MS, status?.state)) {
    return null;
  }

  const message = identityUnverified ? '暂时无法核对 Unity 进程身份' : status.message;
  const error = new Error(`${message}。本次操作未执行，请稍后查询 get_unity_status。`);
  error.code = identityUnverified ? 'UNITY_STATUS_UNVERIFIED' : 'UNITY_BUSY';
  error.details = {
    state: status.state,
    source: status.source,
    freshness: status.freshness,
    updatedAt: status.updatedAt,
    ...(identityUnverified && { lastKnownActivity: status.lastKnownActivity }),
    executionState: 'not_started',
    retryAfterMs: status.retryAfterMs
  };
  return error;
}

async function readActivitySnapshots(activityDir) {
  let entries;
  try {
    entries = await fsp.readdir(activityDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const snapshots = await Promise.all(entries
    .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
    .map(async (entry) => {
      try {
        const raw = await fsp.readFile(path.join(activityDir, entry.name), 'utf8');
        const snapshot = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (
          snapshot.schemaVersion === 1 &&
          entry.name === `${snapshot.pid}.json` &&
          Boolean(normalizeProjectPath(snapshot.projectPath)) &&
          Object.hasOwn(STATE_TEXT, snapshot.state) &&
          snapshot.state !== 'offline' &&
          Number.isFinite(Date.parse(snapshot.processStartedAt)) &&
          Number.isFinite(Date.parse(snapshot.updatedAt)) &&
          Date.parse(snapshot.updatedAt) <= Date.now() + 1000
        ) {
          return snapshot;
        }
      } catch {
        // A replaced/malformed file cannot give a reliable editor phase.
      }
      return null;
    }));
  return snapshots.filter(Boolean);
}

function getProcessStartTime(pid) {
  if (!pendingStartTimeChecks.has(pid)) {
    pendingStartTimeChecks.set(pid, readProcessStartTime(pid).finally(() => pendingStartTimeChecks.delete(pid)));
  }
  return pendingStartTimeChecks.get(pid);
}

async function readProcessStartTime(pid) {
  try {
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const { stdout } = await execFileAsync(powershell, [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ], { timeout: 750, windowsHide: true });
      return Date.parse(stdout.trim());
    }

    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      timeout: 750
    });
    return Date.parse(`${stdout.trim()} UTC`);
  } catch {
    return NaN;
  }
}

function withoutSnapshot(state, observedAt, instance = null, activityTracking = null) {
  const updatedAt = instance?.registration?.lastSeen || null;
  const ageMs = Number.isFinite(Date.parse(updatedAt)) ? Math.max(0, observedAt.getTime() - Date.parse(updatedAt)) : null;
  return {
    ...identityFields(instance),
    state,
    message: STATE_TEXT[state],
    source: updatedAt ? 'registry' : null,
    activityStartedAt: null,
    updatedAt,
    observedAt: observedAt.toISOString(),
    ageMs,
    freshness: ageMs === null ? 'unavailable' : ageMs <= FRESH_AFTER_MS ? 'fresh' : 'stale',
    lastKnownActivity: null,
    activityTracking,
    retryAfterMs: RETRY_AFTER_MS
  };
}

function activityFields(instance) {
  return {
    state: instance.state,
    source: instance.source,
    updatedAt: instance.updatedAt,
    activityStartedAt: instance.activityStartedAt
  };
}

function identityFields(instance) {
  return {
    pid: instance?.pid ?? null,
    projectPath: instance?.projectPath ?? null,
    instanceId: instance?.instanceId ?? null,
    processStartedAt: instance?.processStartedAt ?? null
  };
}

function isEditor(instance) {
  return instance.isBatchMode !== true && instance.isAssetImportWorker !== true;
}

function sameProjectPath(left, right) {
  if (!left || !right) {
    return false;
  }
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function localHost(host = '127.0.0.1') {
  const normalized = host.toLowerCase();
  return ['localhost', '::1', '[::1]'].includes(normalized) ? '127.0.0.1' : normalized;
}
