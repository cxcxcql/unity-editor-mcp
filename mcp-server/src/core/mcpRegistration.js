import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { toMcpToolResult } from './mcpResultAdapter.js';

export function registerMcpHandlers(server, handlers, options = {}) {
  const logger = options.logger;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: Array.from(handlers.values()).map((handler) => handler.getDefinition())
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra = {}) => {
    const { name, arguments: args } = request.params;
    const handler = handlers.get(name);

    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }

    const startTime = Date.now();
    logger?.info?.(`[MCP] Tool call started: ${name}`, { args });

    const result = await handler.handle(args ?? {}, createToolContext(extra));
    logger?.info?.(`[MCP] Tool call completed: ${name}`, {
      status: result.status,
      durationMs: Date.now() - startTime
    });

    return toMcpToolResult(result, name);
  });
}

export function createToolContext(extra = {}) {
  return {
    signal: extra.signal,
    requestMeta: extra._meta,
    sendProgress: async ({ progress, total, message }) => {
      const progressToken = extra._meta?.progressToken;
      if (!progressToken || typeof extra.sendNotification !== 'function') {
        return;
      }

      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          total,
          message
        }
      });
    }
  };
}
