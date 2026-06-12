import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';

const DEFAULT_STALE_AFTER_MS = 30000;

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
  const liveInstances = instances.filter((instance) => !instance.stale && instance.alive);
  const explicitProjectPath = normalizeProjectPath(options.projectPath);
  const inferredProjectPath = explicitProjectPath || findUnityProjectRoot(options.cwd);

  if (inferredProjectPath) {
    const matches = liveInstances.filter((instance) =>
      pathsEqual(instance.normalizedProjectPath, inferredProjectPath)
    );

    if (matches.length > 0) {
      return {
        instance: matches[0],
        reason: explicitProjectPath ? 'explicit project path' : 'current Unity project'
      };
    }

    if (explicitProjectPath) {
      throw new Error(
        `No Unity Editor MCP instance found for project: ${inferredProjectPath}\n\n` +
        formatInstanceCandidates(liveInstances)
      );
    }
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

  if (unityConfig.hasExplicitPort || discoveryConfig.enabled === false) {
    return {
      host,
      port,
      source: unityConfig.hasExplicitPort ? 'explicit-port' : 'discovery-disabled'
    };
  }

  const instances = await readUnityInstances({
    registryDir: discoveryConfig.registryDir,
    staleAfterMs: discoveryConfig.staleAfterMs
  });

  const selection = selectUnityInstance(instances, {
    projectPath: discoveryConfig.projectPath,
    cwd: discoveryConfig.cwd || options.cwd || process.cwd()
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
    projectPath: selection.instance.projectPath
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
  try {
    endpoint = await resolveUnityEndpoint(options);
  } catch (selectionError) {
    error = selectionError.message;
  }

  return {
    registryDir,
    targetProjectPath: normalizeProjectPath(discoveryConfig.projectPath) || findUnityProjectRoot(discoveryConfig.cwd || options.cwd),
    endpoint,
    error,
    instances
  };
}

export function formatDiscoveryReport(report) {
  const lines = [
    'Unity Editor MCP discovery report',
    `Registry: ${report.registryDir}`,
    `Target project: ${report.targetProjectPath || '(not inferred)'}`,
    ''
  ];

  if (report.instances.length === 0) {
    lines.push('No Unity Editor MCP instances were found.');
  } else {
    lines.push('Instances:');
    for (const instance of report.instances) {
      lines.push(
        `- ${instance.projectPath || '(unknown project)'} ` +
        `(pid ${instance.pid}, ${instance.host || '127.0.0.1'}:${instance.port}, ` +
        `${instance.alive ? 'alive' : 'dead'}, ${instance.stale ? 'stale' : 'fresh'})`
      );
    }
  }

  lines.push('');

  if (report.endpoint) {
    lines.push(`Selected endpoint: ${report.endpoint.host}:${report.endpoint.port} (${report.endpoint.source})`);
    if (report.endpoint.projectPath) {
      lines.push(`Selected project: ${report.endpoint.projectPath}`);
    }
  } else {
    lines.push(`Selection error: ${report.error}`);
  }

  return lines.join('\n');
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
      `(pid ${instance.pid}, ${instance.host || '127.0.0.1'}:${instance.port}, Unity ${instance.unityVersion || 'unknown'})`
    )
  ].join('\n');
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
