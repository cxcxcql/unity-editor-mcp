import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerDaemonProxyHandlers } from '../../../src/core/daemonProxy.js';

describe('daemon proxy handlers', () => {
  it('forwards list_tools and call_tool to the daemon MCP client', async () => {
    const requestHandlers = [];
    const server = {
      setRequestHandler: mock.fn((schema, handler) => {
        requestHandlers.push(handler);
      })
    };
    const daemonClient = {
      listTools: mock.fn(async () => ({
        tools: [
          {
            name: 'ping',
            description: 'Ping Unity',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      })),
      callTool: mock.fn(async (params) => ({
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { message: 'pong', args: params.arguments }
      }))
    };

    registerDaemonProxyHandlers(server, {
      getClient: async () => daemonClient
    });

    assert.equal(server.setRequestHandler.mock.calls[0].arguments[0], ListToolsRequestSchema);
    assert.equal(server.setRequestHandler.mock.calls[1].arguments[0], CallToolRequestSchema);

    const tools = await requestHandlers[0]();
    const result = await requestHandlers[1]({
      params: {
        name: 'ping',
        arguments: { message: 'hello' }
      }
    });

    assert.deepEqual(tools.tools.map((tool) => tool.name), ['ping']);
    assert.equal(daemonClient.listTools.mock.calls.length, 1);
    assert.equal(daemonClient.callTool.mock.calls.length, 1);
    assert.deepEqual(daemonClient.callTool.mock.calls[0].arguments[0], {
      name: 'ping',
      arguments: { message: 'hello' }
    });
    assert.deepEqual(result.structuredContent, {
      message: 'pong',
      args: { message: 'hello' }
    });
  });

  it('refreshes the daemon client once when forwarding fails', async () => {
    const requestHandlers = [];
    const server = {
      setRequestHandler: mock.fn((schema, handler) => {
        requestHandlers.push(handler);
      })
    };
    const staleClient = {
      listTools: mock.fn(async () => {
        throw new Error('transport closed');
      })
    };
    const refreshedClient = {
      listTools: mock.fn(async () => ({
        tools: [{ name: 'ping', inputSchema: { type: 'object' } }]
      }))
    };
    const getClient = mock.fn(async ({ forceRefresh } = {}) => (
      forceRefresh ? refreshedClient : staleClient
    ));
    const onClientError = mock.fn(async () => {});

    registerDaemonProxyHandlers(server, {
      getClient,
      onClientError
    });

    const tools = await requestHandlers[0]();

    assert.deepEqual(tools.tools.map((tool) => tool.name), ['ping']);
    assert.equal(staleClient.listTools.mock.calls.length, 1);
    assert.equal(refreshedClient.listTools.mock.calls.length, 1);
    assert.equal(onClientError.mock.calls.length, 1);
    assert.equal(getClient.mock.calls[1].arguments[0].forceRefresh, true);
  });
});
