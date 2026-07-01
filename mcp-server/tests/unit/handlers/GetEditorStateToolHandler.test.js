import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetEditorStateToolHandler } from '../../../src/handlers/playmode/GetEditorStateToolHandler.js';
import { createMockUnityConnection } from '../../utils/test-helpers.js';

describe('GetEditorStateToolHandler', () => {
  let handler;
  let mockConnection;

  beforeEach(() => {
    mockConnection = createMockUnityConnection({
      sendCommandResult: {
        status: 'success',
        state: {
          isPlaying: false,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          applicationPath: '/Applications/Unity/Unity.app',
          applicationContentsPath: '/Applications/Unity/Unity.app/Contents',
          timeSinceStartup: 45.5
        }
      }
    });
    handler = new GetEditorStateToolHandler(mockConnection);
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      assert.equal(handler.name, 'get_editor_state');
      assert.equal(handler.description, 'Get current Unity editor state including play mode status');
      assert.deepEqual(handler.inputSchema.required, []);
    });
  });

  describe('validate', () => {
    it('should pass with empty parameters', () => {
      assert.doesNotThrow(() => handler.validate({}));
    });
  });

  describe('execute', () => {
    it('should get editor state in edit mode', async () => {
      mockConnection.getConnectionInfo = () => ({
        connected: true,
        endpoint: {
          port: 6400,
          instance: {
            pid: 12345,
            projectPath: '/tmp/project',
            packageVersion: '0.15.5'
          }
        }
      });
      const result = await handler.execute({});
      
      assert.equal(mockConnection.sendCommand.mock.calls.length, 1);
      assert.deepEqual(mockConnection.sendCommand.mock.calls[0].arguments, ['get_editor_state', {}, { timeoutMs: 1000 }]);
      
      assert.ok(result);
      assert.ok(result.state);
      assert.equal(result.state.isPlaying, false);
      assert.equal(result.state.isPaused, false);
      assert.equal(result.state.isCompiling, false);
      assert.equal(result.state.isUpdating, false);
      assert.ok(result.state.applicationPath);
      assert.ok(result.state.timeSinceStartup);
      assert.equal(result.connection.endpoint.port, 6400);
      assert.equal(result.connection.endpoint.instance.packageVersion, '0.15.5');
      assert.equal(typeof result.server.gitHead, 'string');
    });

    it('should get editor state in play mode', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'success',
          state: {
            isPlaying: true,
            isPaused: false,
            isCompiling: false,
            isUpdating: false,
            applicationPath: '/Applications/Unity/Unity.app',
            applicationContentsPath: '/Applications/Unity/Unity.app/Contents',
            timeSinceStartup: 120.5
          }
        }
      });
      handler = new GetEditorStateToolHandler(mockConnection);
      
      const result = await handler.execute({});
      
      assert.equal(result.state.isPlaying, true);
      assert.equal(result.state.isPaused, false);
    });

    it('should get editor state when paused', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'success',
          state: {
            isPlaying: true,
            isPaused: true,
            isCompiling: false,
            isUpdating: false,
            applicationPath: '/Applications/Unity/Unity.app',
            applicationContentsPath: '/Applications/Unity/Unity.app/Contents',
            timeSinceStartup: 150.0
          }
        }
      });
      handler = new GetEditorStateToolHandler(mockConnection);
      
      const result = await handler.execute({});
      
      assert.equal(result.state.isPlaying, true);
      assert.equal(result.state.isPaused, true);
    });

    it('should show compiling state', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'success',
          state: {
            isPlaying: false,
            isPaused: false,
            isCompiling: true,
            isUpdating: false,
            applicationPath: '/Applications/Unity/Unity.app',
            applicationContentsPath: '/Applications/Unity/Unity.app/Contents',
            timeSinceStartup: 200.0
          }
        }
      });
      handler = new GetEditorStateToolHandler(mockConnection);
      
      const result = await handler.execute({});
      
      assert.equal(result.state.isCompiling, true);
      assert.equal(result.state.isPlaying, false);
    });

    it('should connect before reading state when disconnected', async () => {
      mockConnection.isConnected.mock.mockImplementation(() => false);

      const result = await handler.execute({});

      assert.equal(mockConnection.connect.mock.calls.length, 1);
      assert.equal(result.state.isPlaying, false);
    });

    it('should retry recoverable listener handoff failures before returning state', async () => {
      const calls = [];
      let connectAttempts = 0;
      mockConnection = {
        isConnected: mock.fn(() => false),
        connect: mock.fn(async () => {
          calls.push(['connect']);
          connectAttempts++;
          if (connectAttempts === 1) {
            const error = new Error('No Unity Editor MCP instance matches the current Unity workspace');
            error.code = 'LOCAL_WORKSPACE_MISMATCH';
            throw error;
          }
        }),
        sendCommand: mock.fn(async (command, params) => {
          calls.push([command, params]);
          return {
            status: 'success',
            state: {
              isPlaying: true,
              isPaused: false,
              isCompiling: false,
              isUpdating: false
            }
          };
        })
      };
      handler = new GetEditorStateToolHandler(mockConnection);

      const result = await handler.execute({}, {
        editorStateRecovery: {
          timeoutMs: 100,
          pollIntervalMs: 0
        }
      });

      assert.equal(result.state.isPlaying, true);
      assert.deepEqual(calls, [
        ['connect'],
        ['connect'],
        ['get_editor_state', {}]
      ]);
    });
  });

  describe('integration with BaseToolHandler', () => {
    it('should handle valid request through handle method', async () => {
      const result = await handler.handle({});
      
      assert.equal(result.status, 'success');
      assert.ok(result.result);
      assert.ok(result.result.state);
      assert.equal(typeof result.result.state.isPlaying, 'boolean');
    });

    it('should return error for Unity errors', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'error',
          error: 'Failed to get editor state'
        }
      });
      handler = new GetEditorStateToolHandler(mockConnection);
      
      const result = await handler.handle({});
      
      assert.equal(result.status, 'error');
      assert.match(result.error, /Failed to get editor state/);
    });
  });
});
