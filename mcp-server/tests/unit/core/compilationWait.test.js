import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { waitForCompilation } from '../../../src/core/compilationWait.js';

describe('waitForCompilation', () => {
  it('completes after compilation is stable and fetches final messages once', async () => {
    const calls = [];
    const states = [
      { success: true, isCompiling: true, isUpdating: true, errorCount: 0, warningCount: 0 },
      { success: true, isCompiling: false, isUpdating: false, errorCount: 0, warningCount: 0 },
      { success: true, isCompiling: false, isUpdating: false, errorCount: 0, warningCount: 0 }
    ];

    const connection = createConnection(async (command, params) => {
      calls.push({ command, params });
      if (params.includeMessages) {
        return {
          success: true,
          isCompiling: false,
          isUpdating: false,
          errorCount: 1,
          warningCount: 0,
          messages: [{ type: 'Error', message: 'CS0103', file: 'Assets/Test.cs', line: 1, column: 1 }]
        };
      }
      return states.shift() || { success: true, isCompiling: false, isUpdating: false, errorCount: 0, warningCount: 0 };
    });

    const result = await waitForCompilation(connection, {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      settleMs: 1,
      includeMessages: true,
      maxMessages: 10
    });

    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.errorCount, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(calls.filter((call) => call.params.includeMessages === true).length, 1);
    assert.ok(calls.slice(0, -1).every((call) => call.params.includeMessages === false));
  });

  it('retries retryable connection errors until Unity responds', async () => {
    let attempts = 0;
    const connection = createConnection(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Connection closed');
      }
      return {
        success: true,
        isCompiling: false,
        isUpdating: false,
        errorCount: 0,
        warningCount: 0
      };
    });

    const result = await waitForCompilation(connection, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      settleMs: 0,
      includeMessages: false
    });

    assert.equal(result.completed, true);
    assert.equal(attempts, 2);
    assert.equal(connection.connectCount, 1);
  });

  it('retries command timeouts while Unity is reloading', async () => {
    let attempts = 0;
    const connection = createConnection(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Command timeout');
      }
      return {
        success: true,
        isCompiling: false,
        isUpdating: false,
        errorCount: 0,
        warningCount: 0
      };
    });

    const result = await waitForCompilation(connection, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      settleMs: 0,
      includeMessages: false
    });

    assert.equal(result.completed, true);
    assert.equal(attempts, 2);
  });

  it('keeps retrying when reconnect fails during domain reload', async () => {
    let commandAttempts = 0;
    const connection = createConnection(async () => {
      commandAttempts++;
      if (commandAttempts === 1) {
        throw new Error('Connection closed');
      }
      return {
        success: true,
        isCompiling: false,
        isUpdating: false,
        errorCount: 0,
        warningCount: 0
      };
    });
    connection.connect = async () => {
      connection.connectCount++;
      if (connection.connectCount <= 2) {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:6400');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      connection.connected = true;
    };

    const result = await waitForCompilation(connection, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      settleMs: 0,
      includeMessages: false
    });

    assert.equal(result.completed, true);
    assert.equal(commandAttempts, 2);
    assert.equal(connection.connectCount, 3);
  });

  it('times out with the latest known state', async () => {
    const connection = createConnection(async () => ({
      success: true,
      isCompiling: true,
      isUpdating: false,
      errorCount: 0,
      warningCount: 0
    }));

    const result = await waitForCompilation(connection, {
      timeoutMs: 5,
      pollIntervalMs: 1,
      settleMs: 1,
      includeMessages: false
    });

    assert.equal(result.completed, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.isCompiling, true);
  });
});

function createConnection(sendCommand) {
  return {
    connectCount: 0,
    connected: true,
    isConnected() {
      return this.connected;
    },
    async connect() {
      this.connectCount++;
      this.connected = true;
    },
    disconnect() {
      this.connected = false;
    },
    async sendCommand(command, params) {
      return sendCommand(command, params);
    }
  };
}
