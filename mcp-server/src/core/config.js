import os from 'os';
import path from 'path';

const cliProjectPath = getCliArgValue(['--project', '--unity-project']);
const cliInstanceId = getCliArgValue(['--instance', '--unity-instance']);
const cliWorkspaceId = getCliArgValue(['--workspace-id', '--unity-workspace-id']);
const cliPort = getCliArgValue(['--port', '--unity-port']);
const explicitPortValue = process.env.UNITY_PORT || cliPort;

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
