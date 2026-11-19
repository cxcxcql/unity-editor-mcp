import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createToolContext } from './mcpRegistration.js';
import { toMcpToolResult } from './mcpResultAdapter.js';

export function registerDaemonProxyHandlers(server, options = {}) {
  const getClient = options.getClient;
  if (typeof getClient !== 'function') {
    throw new Error('registerDaemonProxyHandlers requires getClient');
  }

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra = {}) => {
    const context = { request, extra, method: 'list_tools' };
    const client = await getClient(context);
    try {
      return await client.listTools();
    } catch (error) {
      if (typeof options.onClientError !== 'function') {
        throw error;
      }
      await options.onClientError(error, context);
      const refreshedClient = await getClient({ ...context, forceRefresh: true, failedClient: client });
      return refreshedClient.listTools();
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra = {}) => {
    const { name, arguments: args } = request.params;
    const context = { request, extra, method: 'call_tool', toolName: name };
    let client;
    try {
      client = await getClient(context);
    } catch (error) {
      return daemonCallError(name, error, 'not_started');
    }
    if (extra.signal?.aborted) {
      return toMcpToolResult({
        status: 'error',
        code: 'REQUEST_CANCELLED',
        error: 'Request cancelled',
        details: { executionState: 'not_started' }
      }, name);
    }

    const toolContext = createToolContext(extra);
    const timeoutMs = name === 'wait_for_compilation'
      ? (Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 120000)
      : null;
    try {
      return await client.callTool({ name, arguments: args ?? {} }, undefined, {
        signal: extra.signal,
        ...(extra._meta?.progressToken != null && { onprogress: toolContext.sendProgress }),
        ...(timeoutMs && { timeout: Math.min(2147483647, timeoutMs + 5000) })
      });
    } catch (error) {
      // The daemon may have forwarded this request before the transport failed.
      if (!extra.signal?.aborted) {
        await options.onClientError?.(error, { ...context, failedClient: client });
      }
      return daemonCallError(name, error, 'unknown');
    }
  });
}

function daemonCallError(tool, error, executionState) {
  return toMcpToolResult({
    status: 'error',
    code: 'DAEMON_REQUEST_FAILED',
    error: executionState === 'unknown'
      ? '无法确认 Unity 工具的执行结果，请先核对状态后再决定是否重试。'
      : 'Unity MCP daemon 不可用，本次操作未执行。',
    details: { executionState, cause: error.message }
  }, tool);
}
