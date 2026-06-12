import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WaitForCompilationToolHandler } from '../../../../src/handlers/compilation/WaitForCompilationToolHandler.js';

describe('WaitForCompilationToolHandler', () => {
  let connection;
  let handler;

  beforeEach(() => {
    connection = {
      connected: true,
      commands: [],
      isConnected() {
        return this.connected;
      },
      async connect() {
        this.connected = true;
      },
      async sendCommand(command, params) {
        this.commands.push({ command, params });
        return {
          success: true,
          isCompiling: false,
          isUpdating: false,
          errorCount: params.includeMessages ? 1 : 0,
          warningCount: 0,
          messages: params.includeMessages ? [{ type: 'Error', message: 'CS0103' }] : undefined
        };
      }
    };
    handler = new WaitForCompilationToolHandler(connection);
  });

  it('defines wait parameters', () => {
    assert.equal(handler.name, 'wait_for_compilation');
    assert.equal(handler.inputSchema.properties.timeoutMs.type, 'number');
    assert.equal(handler.inputSchema.properties.pollIntervalMs.type, 'number');
    assert.equal(handler.inputSchema.properties.settleMs.type, 'number');
    assert.equal(handler.inputSchema.properties.includeMessages.type, 'boolean');
    assert.equal(handler.inputSchema.properties.maxMessages.type, 'number');
  });

  it('waits using cheap polls and fetches messages at completion', async () => {
    const result = await handler.execute({
      timeoutMs: 100,
      pollIntervalMs: 1,
      settleMs: 0,
      includeMessages: true,
      maxMessages: 10
    });

    assert.equal(result.completed, true);
    assert.equal(result.errorCount, 1);
    assert.equal(result.messages.length, 1);
    assert.equal(connection.commands[0].params.includeMessages, false);
    assert.equal(connection.commands.at(-1).params.includeMessages, true);
  });
});
