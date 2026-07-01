import os from 'os';
import path from 'path';

const cliProjectPath = getCliArgValue(['--project', '--unity-project']);
const cliInstanceId = getCliArgValue(['--instance', '--unity-instance']);
const cliWorkspaceId = getCliArgValue(['--workspace-id', '--unity-workspace-id']);
const cliAllowSingleInstanceFallback = hasCliFlag(['--allow-single-instance-fallback', '--unity-allow-single-instance-fallback']);
const cliPort = getCliArgValue(['--port', '--unity-port']);
const explicitPortValue = process.env.UNITY_PORT || cliPort;
const cliDaemonPort = getCliArgValue(['--daemon-port', '--mcp-daemon-port']);
const cliDaemonRegistryDir = getCliArgValue(['--daemon-registry-dir', '--mcp-daemon-registry-dir']);

/**
 * Configuration for Unity Editor MCP Server
 */
export const config = {
  // Unity connection settings
  unity: {
    host: process.env.UNITY_HOST || 'localhost',
    port: parseInt(explicitPortValue, 10) || 6400,
    hasExplicitPort: Boolean(explicitPortValue),
    reconnectDelay: 1000, // Initial reconnect delay in ms
    maxReconnectDelay: 30000, // Maximum reconnect delay
    reconnectBackoffMultiplier: 2,
    commandTimeout: 30000, // Command timeout in ms
    discovery: {
      enabled: process.env.UNITY_MCP_DISCOVERY !== 'false',
      instanceId: process.env.UNITY_MCP_INSTANCE_ID || cliInstanceId || '',
      projectPath: process.env.UNITY_PROJECT_PATH || process.env.UNITY_MCP_PROJECT_PATH || cliProjectPath || '',
      workspaceId: process.env.UNITY_MCP_WORKSPACE_ID || cliWorkspaceId || '',
      allowSingleInstanceFallback: parseBoolean(process.env.UNITY_MCP_ALLOW_SINGLE_INSTANCE_FALLBACK) || cliAllowSingleInstanceFallback,
      registryDir: process.env.UNITY_MCP_REGISTRY_DIR || path.join(os.homedir(), '.unity-editor-mcp', 'instances'),
      staleAfterMs: parseInt(process.env.UNITY_MCP_STALE_AFTER_MS, 10) || 30000,
      cwd: process.cwd()
    }
  },
  
  // Server settings
  server: {
    name: 'unity-editor-mcp-server',
    version: '0.1.0',
    description: 'MCP server for Unity Editor integration',
  },

  daemon: {
    enabled: process.env.UNITY_MCP_USE_DAEMON !== 'false',
    host: process.env.UNITY_MCP_DAEMON_HOST || '127.0.0.1',
    port: parseInt(process.env.UNITY_MCP_DAEMON_PORT || cliDaemonPort, 10) || 0,
    registryDir: process.env.UNITY_MCP_DAEMON_REGISTRY_DIR || cliDaemonRegistryDir || path.join(os.homedir(), '.unity-editor-mcp'),
    autoStart: process.env.UNITY_MCP_DAEMON_AUTOSTART !== 'false',
    startupTimeoutMs: parseInt(process.env.UNITY_MCP_DAEMON_STARTUP_TIMEOUT_MS, 10) || 10000,
    healthTimeoutMs: parseInt(process.env.UNITY_MCP_DAEMON_HEALTH_TIMEOUT_MS, 10) || 1000,
    pollIntervalMs: parseInt(process.env.UNITY_MCP_DAEMON_POLL_INTERVAL_MS, 10) || 250,
    heartbeatMs: parseInt(process.env.UNITY_MCP_DAEMON_HEARTBEAT_MS, 10) || 5000,
    staleAfterMs: parseInt(process.env.UNITY_MCP_DAEMON_STALE_AFTER_MS, 10) || 30000,
    maxBodyBytes: parseInt(process.env.UNITY_MCP_DAEMON_MAX_BODY_BYTES, 10) || 1048576
  },

  playModeRecovery: {
    timeoutMs: parseInt(process.env.UNITY_MCP_PLAY_MODE_RECOVERY_TIMEOUT_MS, 10) || 15000,
    stopTransitionTimeoutMs: parseInt(process.env.UNITY_MCP_PLAY_MODE_STOP_TIMEOUT_MS, 10) || 10000,
    pollIntervalMs: parseInt(process.env.UNITY_MCP_PLAY_MODE_POLL_INTERVAL_MS, 10) || 250,
    stateCommandTimeoutMs: parseInt(process.env.UNITY_MCP_PLAY_MODE_STATE_COMMAND_TIMEOUT_MS, 10) || 1000,
    activateUnityOnFreeze: parseBoolean(process.env.UNITY_MCP_ACTIVATE_UNITY_ON_PLAYMODE_FREEZE)
  },
  
  // Logging settings
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    prefix: '[Unity Editor MCP]',
  }
};

function getCliArgValue(names) {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index !== -1 && process.argv[index + 1]) {
      return process.argv[index + 1];
    }
  }

  return '';
}

function hasCliFlag(names) {
  return names.some((name) => process.argv.includes(name));
}

function parseBoolean(value) {
  return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * Logger utility
 * IMPORTANT: In MCP servers, all stdout output must be JSON-RPC protocol messages.
 * Logging must go to stderr to avoid breaking the protocol.
 */
export const logger = {
  info: (message, ...args) => {
    if (['info', 'debug'].includes(config.logging.level)) {
      console.error(`${config.logging.prefix} ${message}`, ...args);
    }
  },
  
  warn: (message, ...args) => {
    if (['info', 'debug', 'warn'].includes(config.logging.level)) {
      console.error(`${config.logging.prefix} WARN: ${message}`, ...args);
    }
  },
  
  error: (message, ...args) => {
    console.error(`${config.logging.prefix} ERROR: ${message}`, ...args);
  },
  
  debug: (message, ...args) => {
    if (config.logging.level === 'debug') {
      console.error(`${config.logging.prefix} DEBUG: ${message}`, ...args);
    }
  }
};
