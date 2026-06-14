import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const DEFAULT_STALE_AFTER_MS = 30000;
const WORKSPACE_ID_RELATIVE_PATH = path.join('unity-editor-mcp', 'workspace-id');
const execFileAsync = promisify(execFile);

export function getDefaultRegistryDir() {
  return path.join(os.homedir(), '.unity-editor-mcp', 'instances');
}

export function normalizeProjectPath(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    return null;
  }

  let normalized = path.resolve(projectPath);
  if (path.basename(normalized).toLowerCase() === 'assets') {
    normalized = path.dirname(normalized);
  }

  return trimTrailingSeparator(normalized);
}

export function findUnityProjectRoot(startDir = process.cwd()) {
  if (!startDir || typeof startDir !== 'string') {
    return null;
  }

  let current = path.resolve(startDir);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }

  while (true) {
    if (
      fs.existsSync(path.join(current, 'Assets')) &&
      fs.existsSync(path.join(current, 'ProjectSettings'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function getLocalWorkspaceIdentity(startDir = process.cwd()) {
  const projectPath = findUnityProjectRoot(startDir);
  if (!projectPath) {
    return null;
  }

  const git = await readGitMetadata(projectPath);
  const workspaceIdInfo = git
    ? await ensureWorkspaceId(git.workspaceIdPath, 'git')
    : await ensureWorkspaceId(path.join(projectPath, 'Library', 'UnityEditorMCP', 'workspace-id'), 'library');

  return {
    projectPath,
    normalizedProjectPath: normalizeProjectPath(projectPath),
    workspaceId: workspaceIdInfo.workspaceId,
    workspaceIdSource: workspaceIdInfo.source,
    workspaceIdPath: workspaceIdInfo.path,
    git
  };
}

export async function readGitMetadata(projectPath) {
  try {
    const [core, branch, head] = await Promise.all([
      runGit(projectPath, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir', '--git-path', WORKSPACE_ID_RELATIVE_PATH]),
      runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      runGit(projectPath, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
    ]);

    const [topLevel, gitDir, commonDir, workspaceIdPath] = core.split('\n').filter(Boolean);
    if (!topLevel || !gitDir || !commonDir || !workspaceIdPath) {
      return null;
    }

    const absoluteGitDir = resolveGitPath(projectPath, gitDir);
    const absoluteCommonDir = resolveGitPath(projectPath, commonDir);

    return {
      topLevel: normalizeProjectPath(topLevel),
      gitDir: trimTrailingSeparator(absoluteGitDir),
      commonDir: trimTrailingSeparator(absoluteCommonDir),
      worktreeName: getWorktreeName(absoluteGitDir, absoluteCommonDir),
      branch: branch || null,
      head: head || null,
      workspaceIdPath: resolveGitPath(projectPath, workspaceIdPath)
    };
  } catch {
    return null;
  }
}

export async function readUnityInstances(options = {}) {
  const registryDir = options.registryDir || getDefaultRegistryDir();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now();
  const includeStale = options.includeStale === true;

  let entries;
  try {
    entries = await fsp.readdir(registryDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const instances = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    const filePath = path.join(registryDir, entry.name);
    try {
      const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      const lastSeenMs = Date.parse(data.lastSeen);
      const stale = !Number.isFinite(lastSeenMs) || now - lastSeenMs > staleAfterMs;
      const alive = isProcessAlive(data.pid);

      if (!includeStale && (stale || !alive)) {
        continue;
      }

      instances.push({
        ...data,
        registryPath: filePath,
        registryDirectory: registryDir,
        normalizedProjectPath: normalizeProjectPath(data.projectPath),
        normalizedGitCommonDir: normalizeMetadataPath(data.git?.commonDir),
        stale,
        alive
      });
    } catch {
      // Ignore malformed or partially-written registry files.
    }
  }

  return instances.sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0));
}

export function selectUnityInstance(instances, options = {}) {
  const liveInstances = instances.filter((instance) => (!instance.stale && instance.alive) || instance.staleExactMatch);
  const explicitInstanceId = normalizeSelector(options.instanceId);
  const explicitProjectPath = normalizeProjectPath(options.projectPath);
  const explicitWorkspaceId = normalizeSelector(options.workspaceId);
  const localWorkspace = options.localWorkspace || null;
  const allowSingleInstanceFallback = options.allowSingleInstanceFallback === true;
  const inferredProjectPath =
    normalizeProjectPath(localWorkspace?.projectPath) ||
    findUnityProjectRoot(options.cwd);
  const inferredWorkspaceId = normalizeSelector(localWorkspace?.workspaceId);

  if (explicitInstanceId) {
    const match = liveInstances.find((instance) => instance.instanceId === explicitInstanceId);
    if (match) {
      return {
        instance: match,
        reason: match.staleExactMatch ? 'stale exact instance ID' : 'explicit instance ID'
      };
    }

    throw new Error(
      `No Unity Editor MCP instance found for instance ID: ${explicitInstanceId}\n\n` +
      formatInstanceCandidates(liveInstances)
    );
  }

  if (explicitProjectPath) {
    const matches = liveInstances.filter((instance) =>
      pathsEqual(instance.normalizedProjectPath, explicitProjectPath)
    );

    if (matches.length > 0) {
      return {
        instance: matches[0],
        reason: matches[0].staleExactMatch ? 'stale exact project path' : 'explicit project path'
      };
    }

    throw new Error(
      `No Unity Editor MCP instance found for project: ${explicitProjectPath}\n\n` +
      formatInstanceCandidates(liveInstances)
    );
  }

  if (explicitWorkspaceId) {
    const match = liveInstances.find((instance) => normalizeSelector(instance.workspaceId) === explicitWorkspaceId);
    if (match) {
      return {
        instance: match,
        reason: match.staleExactMatch ? 'stale exact workspace ID' : 'explicit workspace ID'
      };
    }

    throw new Error(
      `No Unity Editor MCP instance found for workspace ID: ${explicitWorkspaceId}\n\n` +
      formatInstanceCandidates(liveInstances)
    );
  }

  if (inferredProjectPath) {
    const matches = liveInstances.filter((instance) =>
      pathsEqual(instance.normalizedProjectPath, inferredProjectPath)
    );

    if (matches.length > 0) {
      return {
        instance: matches[0],
        reason: matches[0].staleExactMatch ? 'stale current Unity project' : 'current Unity project'
      };
    }
  }

  if (inferredWorkspaceId) {
    const match = liveInstances.find((instance) => normalizeSelector(instance.workspaceId) === inferredWorkspaceId);
    if (match) {
      return {
        instance: match,
        reason: match.staleExactMatch ? 'stale current workspace ID' : 'current workspace ID'
      };
    }
  }

  const mismatchCandidates = findSameRepositoryCandidates(liveInstances, localWorkspace);
  if (mismatchCandidates.length > 0) {
    throw createWorktreeMismatchError(localWorkspace, mismatchCandidates);
  }

  if ((inferredProjectPath || inferredWorkspaceId) && !allowSingleInstanceFallback) {
    throw createLocalWorkspaceMismatchError(localWorkspace, inferredProjectPath, inferredWorkspaceId, liveInstances);
  }

  if (liveInstances.length === 1) {
    return {
      instance: liveInstances[0],
      reason: 'single live Unity instance'
    };
  }

  if (liveInstances.length === 0) {
    return null;
  }

  throw new Error(
    'Multiple Unity Editor MCP instances are running and no target project could be inferred.\n\n' +
    formatInstanceCandidates(liveInstances) +
    '\nSet UNITY_PROJECT_PATH, pass --project <path>, or start the MCP server from inside the Unity project.'
  );
}

export async function resolveUnityEndpoint(options = {}) {
  const unityConfig = options.unityConfig || {};
  const discoveryConfig = unityConfig.discovery || {};
  const host = unityConfig.host || 'localhost';
  const port = unityConfig.port || 6400;

  if (unityConfig.hasExplicitPort) {
    const registryMatch = discoveryConfig.enabled === false
      ? null
      : await findRegistryEndpointByPort(host, port, {
        registryDir: discoveryConfig.registryDir,
        staleAfterMs: discoveryConfig.staleAfterMs
      });
    return {
      host,
      port,
      source: 'explicit-port',
      ...(registryMatch && { instance: registryMatch, authToken: registryMatch.authToken })
    };
  }

  if (discoveryConfig.enabled === false) {
    return {
      host,
      port,
      source: 'discovery-disabled'
    };
  }

  const portProbe = options.canConnectToPort || canConnectToPort;
  const cachedEndpoint = await getConnectableCachedEndpoint(options.lastEndpoint, portProbe, {
    registryDir: discoveryConfig.registryDir,
    staleAfterMs: discoveryConfig.staleAfterMs
  });
  if (cachedEndpoint) {
    return cachedEndpoint;
  }

  const identityStart = discoveryConfig.projectPath || discoveryConfig.cwd || options.cwd || process.cwd();
  const localWorkspace = options.localWorkspace === undefined
    ? await getLocalWorkspaceIdentity(identityStart)
    : options.localWorkspace;

  const instances = await readUnityInstances({
    registryDir: discoveryConfig.registryDir,
    staleAfterMs: discoveryConfig.staleAfterMs,
    includeStale: true
  });
  const selectableInstances = await promoteConnectableExactMatches(instances, {
    instanceId: discoveryConfig.instanceId,
    projectPath: discoveryConfig.projectPath,
    workspaceId: discoveryConfig.workspaceId,
    localWorkspace,
    fallbackHost: host,
    canConnect: portProbe
  });
  const selection = selectUnityInstance(selectableInstances, {
    instanceId: discoveryConfig.instanceId,
    projectPath: discoveryConfig.projectPath,
    workspaceId: discoveryConfig.workspaceId,
    allowSingleInstanceFallback: discoveryConfig.allowSingleInstanceFallback === true,
    cwd: discoveryConfig.cwd || options.cwd || process.cwd(),
    localWorkspace
  });

  if (!selection) {
    return {
      host,
      port,
      source: 'default-port'
    };
  }

  return {
    host: selection.instance.host || host,
    port: selection.instance.port,
    source: 'discovery',
    reason: selection.reason,
    instance: selection.instance,
    projectPath: selection.instance.projectPath,
    authToken: selection.instance.authToken
  };
}

export async function createDiscoveryReport(options = {}) {
  const unityConfig = options.unityConfig || {};
  const discoveryConfig = unityConfig.discovery || {};
  const registryDir = discoveryConfig.registryDir || getDefaultRegistryDir();
  const instances = await readUnityInstances({
    registryDir,
    staleAfterMs: discoveryConfig.staleAfterMs,
    includeStale: true
  });

  let endpoint = null;
  let error = null;
  let errorCode = null;
  const identityStart = discoveryConfig.projectPath || discoveryConfig.cwd || options.cwd || process.cwd();
  const localWorkspace = options.localWorkspace === undefined
    ? await getLocalWorkspaceIdentity(identityStart)
    : options.localWorkspace;
  try {
    endpoint = await resolveUnityEndpoint({
      ...options,
      localWorkspace
    });
  } catch (selectionError) {
    error = selectionError.message;
    errorCode = selectionError.code || null;
  }

  return {
    registryDir,
    targetProjectPath: normalizeProjectPath(discoveryConfig.projectPath) || findUnityProjectRoot(discoveryConfig.cwd || options.cwd),
    targetWorkspaceId: normalizeSelector(discoveryConfig.workspaceId) || localWorkspace?.workspaceId || null,
    localWorkspace,
    endpoint,
    error,
    errorCode,
    instances
  };
}

export function formatDiscoveryReport(report) {
  const safeReport = redactDiscoveryReport(report);
  const lines = [
    'Unity Editor MCP discovery report',
    `Registry: ${safeReport.registryDir}`,
    `Target project: ${safeReport.targetProjectPath || '(not inferred)'}`,
    `Target workspace: ${safeReport.targetWorkspaceId || '(not inferred)'}`,
    ''
  ];

  if (safeReport.instances.length === 0) {
    lines.push('No Unity Editor MCP instances were found.');
  } else {
    lines.push('Instances:');
    for (const instance of safeReport.instances) {
      lines.push(
        `- ${instance.projectPath || '(unknown project)'} ` +
        `(pid ${instance.pid}, ${instance.host || '127.0.0.1'}:${instance.port}, ` +
        `${instance.alive ? 'alive' : 'dead'}, ${instance.stale ? 'stale' : 'fresh'}, ` +
        `workspace ${instance.workspaceId || 'unknown'})`
      );
    }
  }

  lines.push('');

  if (safeReport.endpoint) {
    lines.push(`Selected endpoint: ${safeReport.endpoint.host}:${safeReport.endpoint.port} (${safeReport.endpoint.source})`);
    if (safeReport.endpoint.projectPath) {
      lines.push(`Selected project: ${safeReport.endpoint.projectPath}`);
    }
  } else {
    lines.push(`Selection error: ${safeReport.errorCode ? `[${safeReport.errorCode}] ` : ''}${safeReport.error}`);
  }

  return lines.join('\n');
}

export function redactDiscoveryReport(report) {
  return redactAuthTokens(report);
}

export function canConnectToPort(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function formatInstanceCandidates(instances) {
  if (!instances.length) {
    return 'Open Unity with the Unity Editor MCP package installed, then try again.';
  }

  return [
    'Available Unity Editor MCP instances:',
    ...instances.map((instance) =>
      `- ${instance.projectPath || '(unknown project)'} ` +
      `(pid ${instance.pid}, ${instance.host || '127.0.0.1'}:${instance.port}, ` +
      `Unity ${instance.unityVersion || 'unknown'}, workspace ${instance.workspaceId || 'unknown'}, ` +
      `branch ${instance.git?.branch || 'unknown'})`
    )
  ].join('\n');
}

async function getConnectableCachedEndpoint(endpoint, canConnect, registryOptions = {}) {
  if (!endpoint?.instance?.pid || !endpoint.port || !isProcessAlive(endpoint.instance.pid)) {
    return null;
  }

  const host = endpoint.host || endpoint.instance.host || '127.0.0.1';
  if (!(await canConnect(host, endpoint.port))) {
    return null;
  }

  // Refresh the auth token from the registry before reusing the cached endpoint.
  // A Unity domain reload (entering/exiting play mode, a recompile) regenerates the
  // per-session auth token while keeping the same pid and port, so the cached token
  // goes stale even though the port is still connectable — which would otherwise yield
  // AUTH_FAILED on every command until the bridge is manually restarted.
  let { instance, authToken } = endpoint;
  const fresh = await findRegistryEndpointByPort(host, endpoint.port, registryOptions);
  if (fresh && fresh.pid === endpoint.instance.pid) {
    instance = fresh;
    authToken = fresh.authToken ?? authToken;
  }

  return {
    ...endpoint,
    host,
    instance,
    authToken,
    source: 'cached-endpoint'
  };
}

async function findRegistryEndpointByPort(host, port, options = {}) {
  const instances = await readUnityInstances({
    registryDir: options.registryDir,
    staleAfterMs: options.staleAfterMs,
    includeStale: false
  });

  return instances.find((instance) =>
    Number(instance.port) === Number(port) &&
    normalizeHost(instance.host || '127.0.0.1') === normalizeHost(host || '127.0.0.1')
  ) || null;
}

function redactAuthTokens(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuthTokens(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    copy[key] = key === 'authToken' ? '[redacted]' : redactAuthTokens(child);
  }
  return copy;
}

function normalizeHost(host) {
  const value = String(host || '').toLowerCase();
  return value === 'localhost' ? '127.0.0.1' : value;
}

async function promoteConnectableExactMatches(instances, options) {
  const promoted = [];
  for (const instance of instances) {
    if (!instance.stale || !instance.alive || !isExactSelectorMatch(instance, options)) {
      promoted.push(instance);
      continue;
    }

    const host = instance.host || options.fallbackHost || '127.0.0.1';
    const port = instance.port;
    const connectable = Number.isInteger(port) && await options.canConnect(host, port);
    promoted.push(connectable
      ? {
        ...instance,
        staleExactMatch: true,
        originalStale: true
      }
      : instance
    );
  }

  return promoted;
}

function isExactSelectorMatch(instance, options) {
  const instanceId = normalizeSelector(options.instanceId);
  if (instanceId && instance.instanceId === instanceId) {
    return true;
  }

  const projectPath = normalizeProjectPath(options.projectPath);
  if (projectPath && pathsEqual(instance.normalizedProjectPath, projectPath)) {
    return true;
  }

  const workspaceId = normalizeSelector(options.workspaceId);
  if (workspaceId && normalizeSelector(instance.workspaceId) === workspaceId) {
    return true;
  }

  const localProjectPath = normalizeProjectPath(options.localWorkspace?.projectPath);
  if (localProjectPath && pathsEqual(instance.normalizedProjectPath, localProjectPath)) {
    return true;
  }

  const localWorkspaceId = normalizeSelector(options.localWorkspace?.workspaceId);
  return Boolean(localWorkspaceId && normalizeSelector(instance.workspaceId) === localWorkspaceId);
}

async function runGit(projectPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args], {
    timeout: 3000
  });
  return stdout.trim();
}

async function ensureWorkspaceId(filePath, source) {
  const existing = await readWorkspaceId(filePath);
  if (existing) {
    return {
      workspaceId: existing,
      source,
      path: filePath
    };
  }

  const workspaceId = randomUUID();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${workspaceId}\n`, { mode: 0o600 });

  return {
    workspaceId,
    source,
    path: filePath
  };
}

async function readWorkspaceId(filePath) {
  try {
    const value = (await fsp.readFile(filePath, 'utf8')).trim();
    return value || null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveGitPath(projectPath, gitPath) {
  const resolved = path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(projectPath, gitPath);
  try {
    return trimTrailingSeparator(fs.realpathSync.native(resolved));
  } catch {
    return trimTrailingSeparator(resolved);
  }
}

function getWorktreeName(gitDir, commonDir) {
  const worktreesDir = path.join(commonDir, 'worktrees');
  const relative = path.relative(worktreesDir, gitDir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep)[0];
  }

  return 'main';
}

function findSameRepositoryCandidates(instances, localWorkspace) {
  const localCommonDir = normalizeMetadataPath(localWorkspace?.git?.commonDir);
  if (!localCommonDir) {
    return [];
  }

  return instances.filter((instance) =>
    pathsEqual(normalizeMetadataPath(instance.git?.commonDir), localCommonDir)
  );
}

function createWorktreeMismatchError(localWorkspace, candidates) {
  const error = new Error(
    'Unity Editor MCP found editor instances from the same Git repository, but none match the current worktree.\n\n' +
    `Current project: ${localWorkspace?.projectPath || '(unknown)'}\n` +
    `Current workspace: ${localWorkspace?.workspaceId || '(unknown)'}\n\n` +
    formatInstanceCandidates(candidates) +
    '\nOpen the matching Unity worktree, pass --project <path>, or pass --instance <id>.'
  );
  error.code = 'WORKTREE_MISMATCH';
  error.candidates = candidates;
  return error;
}

function createLocalWorkspaceMismatchError(localWorkspace, projectPath, workspaceId, candidates) {
  const error = new Error(
    'No Unity Editor MCP instance matches the current Unity workspace.\n\n' +
    `Current project: ${localWorkspace?.projectPath || projectPath || '(unknown)'}\n` +
    `Current workspace: ${localWorkspace?.workspaceId || workspaceId || '(unknown)'}\n\n` +
    formatInstanceCandidates(candidates) +
    '\nOpen the matching Unity project, pass --project <path>, pass --instance <id>, or opt in with --allow-single-instance-fallback.'
  );
  error.code = 'LOCAL_WORKSPACE_MISMATCH';
  error.candidates = candidates;
  return error;
}

function normalizeSelector(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeMetadataPath(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const resolved = path.resolve(value);
  try {
    return trimTrailingSeparator(fs.realpathSync.native(resolved));
  } catch {
    return trimTrailingSeparator(resolved);
  }
}

function pathsEqual(a, b) {
  if (!a || !b) {
    return false;
  }

  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }

  return a === b;
}

function trimTrailingSeparator(value) {
  if (value.length <= 1) {
    return value;
  }

  return value.replace(/[\\/]$/, '');
}
