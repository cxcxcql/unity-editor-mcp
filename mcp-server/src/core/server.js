#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UnityConnection } from './unityConnection.js';
import { registerMcpHandlers } from './mcpRegistration.js';
import { createHandlers } from '../handlers/index.js';
import { config, logger } from './config.js';

// Create Unity connection
const unityConnection = new UnityConnection();

// Create tool handlers
const handlers = createHandlers(unityConnection);

// Create MCP server
const server = new Server(
  {
    name: config.server.name,
    version: config.server.version,
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

registerMcpHandlers(server, handlers, { logger });

// Handle connection events
unityConnection.on('connected', () => {
  logger.info('Unity connection established');
});

unityConnection.on('disconnected', () => {
  logger.info('Unity connection lost');
});

unityConnection.on('error', (error) => {
  logger.error('Unity connection error:', error.message);
});

// Initialize server
export async function main() {
  try {
    // Create transport - no logging before connection
    const transport = new StdioServerTransport();
    
    // Connect to transport
    await server.connect(transport);
    
    // Now safe to log after connection established
    logger.info('MCP server started successfully');
    
    // Attempt to connect to Unity
    try {
      await unityConnection.connect();
    } catch (error) {
      logger.error('Initial Unity connection failed:', error.message);
      logger.info('Unity connection will retry automatically');
    }
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down...');
      unityConnection.disconnect();
      await server.close();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('Shutting down...');
      unityConnection.disconnect();
      await server.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Export for testing
export async function createServer(customConfig = config) {
  const testUnityConnection = new UnityConnection();
  const testHandlers = createHandlers(testUnityConnection);
  
  const testServer = new Server(
    {
      name: customConfig.server.name,
      version: customConfig.server.version,
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );
  
  registerMcpHandlers(testServer, testHandlers, { logger });
  
  return {
    server: testServer,
    unityConnection: testUnityConnection
  };
}

// Start the server
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  });
}
