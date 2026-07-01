import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function registerDaemonProxyHandlers(server, options = {}) {
  const getClient = options.getClient;
  if (typeof getClient !== 'function') {
    throw new Error('registerDaemonProxyHandlers requires getClient');
  }

  const forward = async (operation, context) => {
    const client = await getClient(context);
    try {
      return await operation(client);
    } catch (error) {
      if (typeof options.onClientError !== 'function') {
        throw error;
      }

      await options.onClientError(error, context);
      const refreshedClient = await getClient({ ...context, forceRefresh: true });
      return operation(refreshedClient);
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request, extra = {}) => {
    return forward(
      (client) => client.listTools(),
      { request, extra, method: 'list_tools' }
    );
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra = {}) => {
    const { name, arguments: args } = request.params;
    return forward(
      (client) => client.callTool({
        name,
        arguments: args ?? {}
      }),
      { request, extra, method: 'call_tool', toolName: name }
    );
  });
}
