import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshAssetsToolHandler } from '../../../src/handlers/system/RefreshAssetsToolHandler.js';
import { createMockUnityConnection } from '../../utils/test-helpers.js';

describe('RefreshAssetsToolHandler', () => {
  let handler;
  let mockConnection;

  beforeEach(() => {
    mockConnection = createMockUnityConnection({
      sendCommandResult: {
        "success": true,
        "message": "Assets refreshed successfully",
        "compilationStatus": "Success"
      }
    });
    handler = new RefreshAssetsToolHandler(mockConnection);
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      assert.ok(handler.name);
      assert.ok(handler.description);
      assert.deepEqual(handler.inputSchema.required, []);
    });
  });

  describe('validate', () => {
    it('should pass with valid parameters', () => {
      assert.doesNotThrow(() => handler.validate({}));
    });

  });

  describe('execute', () => {
    it('should execute successfully with valid params', async () => {
      const result = await handler.execute({});
      
      assert.equal(mockConnection.sendCommand.mock.calls.length, 1);
      assert.ok(result);  // Handler returns the raw Unity response
      // Message is added by handler if present in Unity response
    });

    it('should connect if not connected', async () => {
      mockConnection.isConnected.mock.mockImplementation(() => false);
      mockConnection.connect = mock.fn(async () => {});
      
      await handler.execute({});
      
      assert.equal(mockConnection.connect.mock.calls.length, 1);
    });

    it('should wait for compilation when requested', async () => {
      const commands = [];
      mockConnection.sendCommand = mock.fn(async (command, params) => {
        commands.push({ command, params });
        if (command === 'refresh_assets') {
          return {
            message: 'Asset refresh triggered',
            isCompiling: true,
            timestamp: '2026-06-13T00:00:00.000Z'
          };
        }

        return {
          success: true,
          isCompiling: false,
          isUpdating: false,
          errorCount: params.includeMessages ? 0 : 0,
          warningCount: 0,
          messages: params.includeMessages ? [] : undefined
        };
      });

      const result = await handler.execute({
        waitForCompletion: true,
        timeoutMs: 100,
        pollIntervalMs: 1,
        settleMs: 0,
        includeMessages: true
      });

      assert.equal(commands[0].command, 'refresh_assets');
      assert.equal(commands[1].command, 'get_compilation_state');
      assert.equal(commands[1].params.includeMessages, false);
      assert.equal(commands.at(-1).params.includeMessages, true);
      assert.equal(result.compilation.completed, true);
    });
  });

  describe('integration with BaseToolHandler', () => {
    it('should handle valid request through handle method', async () => {
      const result = await handler.handle({});
      
      assert.equal(result.status, 'success');
      assert.ok(result.result);
    });

  });
});
