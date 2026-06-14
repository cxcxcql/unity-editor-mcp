import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PlayToolHandler } from '../../../src/handlers/playmode/PlayToolHandler.js';
import { createMockUnityConnection } from '../../utils/test-helpers.js';

describe('PlayToolHandler', () => {
  let handler;
  let mockConnection;

  beforeEach(() => {
    mockConnection = createMockUnityConnection({
      sendCommandResult: {
        status: 'success',
        message: 'Entered play mode',
        state: {
          isPlaying: true,
          isPaused: false,
          isCompiling: false,
          timeSinceStartup: 0.0
        }
      }
    });
    handler = new PlayToolHandler(mockConnection);
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      assert.equal(handler.name, 'play_game');
      assert.equal(handler.description, 'Start Unity play mode to test the game');
      assert.deepEqual(handler.inputSchema.required, []);
    });
  });

  describe('validate', () => {
    it('should pass with empty parameters', () => {
      assert.doesNotThrow(() => handler.validate({}));
    });
  });

  describe('execute', () => {
    it('should start play mode successfully', async () => {
      const result = await handler.execute({});
      
      assert.equal(mockConnection.sendCommand.mock.calls.length, 1);
      assert.deepEqual(mockConnection.sendCommand.mock.calls[0].arguments, ['play_game', {}]);
      
      assert.ok(result);
      assert.equal(result.message, 'Entered play mode');
      assert.deepEqual(result.state, {
        isPlaying: true,
        isPaused: false,
        isCompiling: false,
        timeSinceStartup: 0.0
      });
    });

    it('should handle already playing state', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'success',
          message: 'Already in play mode',
          state: {
            isPlaying: true,
            isPaused: false,
            isCompiling: false,
            timeSinceStartup: 5.5
          }
        }
      });
      handler = new PlayToolHandler(mockConnection);
      
      const result = await handler.execute({});
      
      assert.equal(result.message, 'Already in play mode');
      assert.equal(result.state.isPlaying, true);
    });

    it('should throw error if not connected', async () => {
      mockConnection.isConnected.mock.mockImplementation(() => false);
      
      await assert.rejects(
        async () => await handler.execute({}),
        /Unity connection not available/
      );
    });

    it('should handle Unity errors', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'error',
          error: 'Cannot enter play mode: Compilation errors exist'
        }
      });
      handler = new PlayToolHandler(mockConnection);
      
      await assert.rejects(
        async () => await handler.execute({}),
        /Cannot enter play mode: Compilation errors exist/
      );
    });

    it('should recover when Unity closes the connection while entering play mode', async () => {
      const calls = [];
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {
          calls.push(['connect']);
        }),
        sendCommand: mock.fn(async (command, params) => {
          calls.push([command, params]);
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }
          return {
            status: 'success',
            state: {
              isPlaying: true,
              isPaused: false,
              isCompiling: false,
              isUpdating: false,
              timeSinceStartup: 12
            }
          };
        })
      };
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.execute({});

      assert.equal(result.status, 'success');
      assert.equal(result.message, 'Entered play mode after reconnect');
      assert.equal(result.recoveredAfterReconnect, true);
      assert.equal(result.state.isPlaying, true);
      assert.deepEqual(calls, [
        ['play_game', {}],
        ['connect'],
        ['get_editor_state', {}]
      ]);
    });

    it('should retry reconnects until play mode state is verified after a reload', async () => {
      const calls = [];
      let connectAttempts = 0;
      let statePolls = 0;
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {
          calls.push(['connect']);
          connectAttempts++;
          if (connectAttempts < 3) {
            throw new Error('Connection timeout');
          }
        }),
        sendCommand: mock.fn(async (command, params) => {
          calls.push([command, params]);
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }

          statePolls++;
          return {
            status: 'success',
            state: {
              isPlaying: statePolls >= 2,
              isPaused: false,
              isCompiling: false,
              isUpdating: false
            }
          };
        })
      };
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.execute({}, {
        playModeRecovery: {
          timeoutMs: 100,
          pollIntervalMs: 0
        }
      });

      assert.equal(result.status, 'success');
      assert.equal(result.recoveredAfterReconnect, true);
      assert.equal(result.state.isPlaying, true);
      assert.equal(result.attempts, 5);
      assert.deepEqual(calls, [
        ['play_game', {}],
        ['connect'],
        ['connect'],
        ['connect'],
        ['get_editor_state', {}],
        ['get_editor_state', {}]
      ]);
    });

    it('should retry transient discovery gaps through the MCP handle path', async () => {
      const calls = [];
      let connectAttempts = 0;
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {
          calls.push(['connect']);
          connectAttempts++;
          if (connectAttempts < 3) {
            const error = new Error('No Unity Editor MCP instance found for project: TestProject');
            error.code = 'NO_UNITY_INSTANCE';
            throw error;
          }
        }),
        sendCommand: mock.fn(async (command, params) => {
          calls.push([command, params]);
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }

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
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.handle({}, {
        playModeRecovery: {
          timeoutMs: 100,
          pollIntervalMs: 0
        }
      });

      assert.equal(result.status, 'success');
      assert.equal(result.result.recoveredAfterReconnect, true);
      assert.equal(result.result.state.isPlaying, true);
      assert.deepEqual(calls, [
        ['play_game', {}],
        ['connect'],
        ['connect'],
        ['connect'],
        ['get_editor_state', {}]
      ]);
    });

    it('should retry transient workspace mismatch errors during play mode reload', async () => {
      const calls = [];
      let connectAttempts = 0;
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {
          calls.push(['connect']);
          connectAttempts++;
          if (connectAttempts < 3) {
            const error = new Error('No Unity Editor MCP instance matches the current Unity workspace');
            error.code = 'LOCAL_WORKSPACE_MISMATCH';
            throw error;
          }
        }),
        sendCommand: mock.fn(async (command, params) => {
          calls.push([command, params]);
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }

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
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.handle({}, {
        playModeRecovery: {
          timeoutMs: 100,
          pollIntervalMs: 0
        }
      });

      assert.equal(result.status, 'success');
      assert.equal(result.result.recoveredAfterReconnect, true);
      assert.equal(result.result.state.isPlaying, true);
      assert.deepEqual(calls, [
        ['play_game', {}],
        ['connect'],
        ['connect'],
        ['connect'],
        ['get_editor_state', {}]
      ]);
    });

    it('should retry bounded state poll command timeouts during play mode recovery', async () => {
      const calls = [];
      let statePolls = 0;
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {
          calls.push(['connect']);
        }),
        sendCommand: mock.fn(async (command, params, options) => {
          calls.push([command, params, options]);
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }

          statePolls++;
          if (statePolls === 1) {
            const error = new Error('Command timeout');
            error.code = 'COMMAND_TIMEOUT';
            throw error;
          }

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
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.handle({}, {
        playModeRecovery: {
          timeoutMs: 100,
          pollIntervalMs: 0,
          commandTimeoutMs: 10
        }
      });

      assert.equal(result.status, 'success');
      assert.equal(result.result.state.isPlaying, true);
      assert.deepEqual(calls, [
        ['play_game', {}, undefined],
        ['connect'],
        ['get_editor_state', {}, { timeoutMs: 10 }],
        ['connect'],
        ['get_editor_state', {}, { timeoutMs: 10 }]
      ]);
    });

    it('should return a structured timeout error when play mode cannot be verified', async () => {
      mockConnection = {
        isConnected: mock.fn(() => true),
        connect: mock.fn(async () => {}),
        sendCommand: mock.fn(async (command) => {
          if (command === 'play_game') {
            throw new Error('Connection closed');
          }

          return {
            status: 'success',
            state: {
              isPlaying: false,
              isPaused: false
            }
          };
        })
      };
      handler = new PlayToolHandler(mockConnection);

      const result = await handler.handle({}, {
        playModeRecovery: {
          timeoutMs: 5,
          pollIntervalMs: 0
        }
      });

      assert.equal(result.status, 'error');
      assert.equal(result.code, 'PLAY_MODE_RECOVERY_TIMEOUT');
      assert.equal(result.details.lastState.isPlaying, false);
      assert.equal(typeof result.details.attempts, 'number');
      assert.equal(typeof result.details.elapsedMs, 'number');
    });
  });

  describe('integration with BaseToolHandler', () => {
    it('should handle valid request through handle method', async () => {
      const result = await handler.handle({});
      
      assert.equal(result.status, 'success');
      assert.ok(result.result);
      assert.equal(result.result.message, 'Entered play mode');
    });

    it('should return error for Unity errors', async () => {
      mockConnection = createMockUnityConnection({
        sendCommandResult: {
          status: 'error',
          error: 'Compilation errors prevent play mode'
        }
      });
      handler = new PlayToolHandler(mockConnection);
      
      const result = await handler.handle({});
      
      assert.equal(result.status, 'error');
      assert.match(result.error, /Compilation errors prevent play mode/);
    });
  });
});
