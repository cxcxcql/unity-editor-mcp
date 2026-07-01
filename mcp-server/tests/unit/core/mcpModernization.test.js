import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../../src/core/server.js';
import { createHandlers } from '../../../src/handlers/index.js';
import { redactDiscoveryReport } from '../../../src/core/unityDiscovery.js';
import { UnityConnection } from '../../../src/core/unityConnection.js';
import { RunTestsToolHandler } from '../../../src/handlers/test/RunTestsToolHandler.js';
import { DeleteGameObjectToolHandler } from '../../../src/handlers/gameobject/DeleteGameObjectToolHandler.js';
import { LoadSceneToolHandler } from '../../../src/handlers/scene/LoadSceneToolHandler.js';
import { GetGameObjectDetailsToolHandler } from '../../../src/handlers/analysis/GetGameObjectDetailsToolHandler.js';
import { ReadLogsToolHandler } from '../../../src/handlers/system/ReadLogsToolHandler.js';

describe('MCP modernization contracts', () => {
  it('returns structuredContent for successful MCP tool calls', async () => {
    const { server, unityConnection } = await createServer({
      server: { name: 'test-unity-mcp', version: '1.0.0' }
    });
    unityConnection.isConnected = mock.fn(() => true);
    unityConnection.sendCommand = mock.fn(async () => ({
      message: 'pong',
      timestamp: '2026-06-13T00:00:00.000Z'
    }));

    const callTool = server._requestHandlers.get('tools/call');
    const result = await callTool({
      method: 'tools/call',
      params: {
        name: 'ping',
        arguments: { message: 'hello' }
      }
    }, {});

    assert.ok(result.content[0].text.includes('pong'));
    assert.equal(result.structuredContent.message, 'pong');
    assert.equal(result.isError, undefined);

    await server.close();
  });

  it('returns isError and structured error content for tool execution failures', async () => {
    const { server, unityConnection } = await createServer({
      server: { name: 'test-unity-mcp', version: '1.0.0' }
    });
    unityConnection.isConnected = mock.fn(() => true);
    unityConnection.sendCommand = mock.fn(async () => {
      const error = new Error('Unity exploded');
      error.code = 'UNITY_ERROR';
      throw error;
    });

    const callTool = server._requestHandlers.get('tools/call');
    const result = await callTool({
      method: 'tools/call',
      params: {
        name: 'ping',
        arguments: {}
      }
    }, {});

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'UNITY_ERROR');
    assert.equal(result.structuredContent.message, 'Unity exploded');

    await server.close();
  });

  it('rejects schema-invalid types, enum values, ranges, unknown properties, and either-or inputs', async () => {
    const connection = createConnection();
    const runTests = new RunTestsToolHandler(connection);
    const deleteGameObject = new DeleteGameObjectToolHandler(connection);
    const loadScene = new LoadSceneToolHandler(connection);
    const details = new GetGameObjectDetailsToolHandler(connection);
    const readLogs = new ReadLogsToolHandler(connection);

    assertSchemaValidationError(await runTests.handle({ testMode: 'BadMode' }));
    assertSchemaValidationError(await runTests.handle({ testNames: [123] }));
    assertSchemaValidationError(await runTests.handle({ unknown: true }));
    assertRejected(await readLogs.handle({ count: 1001 }));
    assertRejected(await deleteGameObject.handle({ paths: [] }));
    assertRejected(await loadScene.handle({ sceneName: 'Main', scenePath: 'Assets/Main.unity' }));
    assertSchemaValidationError(await details.handle({ gameObjectName: 'Player', path: '/Player' }));

    const pathOnly = await details.handle({ path: '/Player' });
    assert.equal(pathOnly.status, 'success');
  });

  it('includes conservative tool annotations in listed tool definitions', () => {
    const handlers = createHandlers(createConnection());
    const readLogs = handlers.get('read_logs').getDefinition();
    const createGameObject = handlers.get('create_gameobject').getDefinition();

    assert.equal(readLogs.annotations.readOnlyHint, true);
    assert.equal(readLogs.annotations.destructiveHint, false);
    assert.equal(createGameObject.annotations.readOnlyHint, false);
    assert.equal(createGameObject.annotations.destructiveHint, true);
    assert.ok(readLogs.outputSchema);
  });

  it('redacts auth tokens from discovery reports', () => {
    const report = redactDiscoveryReport({
      endpoint: {
        host: '127.0.0.1',
        port: 6400,
        authToken: 'secret-token',
        instance: { authToken: 'nested-token' }
      },
      instances: [
        { instanceId: 'abc', authToken: 'instance-token' }
      ]
    });

    assert.equal(report.endpoint.authToken, '[redacted]');
    assert.equal(report.endpoint.instance.authToken, '[redacted]');
    assert.equal(report.instances[0].authToken, '[redacted]');
  });

  it('includes the endpoint auth token in Unity command envelopes without exposing connection info', async () => {
    const connection = new UnityConnection({
      config: {
        unity: {
          commandTimeout: 100,
          reconnectDelay: 10,
          maxReconnectDelay: 10,
          reconnectBackoffMultiplier: 2
        }
      }
    });
    const writes = [];
    let resolveWrite;
    const firstWrite = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    connection.connected = true;
    connection.endpoint = { authToken: 'secret-token' };
    connection.socket = {
      write: mock.fn((buffer, callback) => {
        writes.push(buffer);
        resolveWrite(buffer);
        callback?.();
      })
    };

    const commandPromise = connection.sendCommand('ping', {});
    const command = parseFramedMessage(await firstWrite);
    assert.equal(command.authToken, 'secret-token');
    assert.equal(connection.getConnectionInfo().endpoint.authToken, '[redacted]');

    connection.pendingCommands.get('1').resolve({ ok: true });
    assert.deepEqual(await commandPromise, { ok: true });
  });
});

function assertSchemaValidationError(result) {
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'INVALID_PARAMS');
}

function assertRejected(result) {
  assert.equal(result.status, 'error');
}

function createConnection() {
  return {
    isConnected: mock.fn(() => true),
    connect: mock.fn(async () => {}),
    sendCommand: mock.fn(async () => ({ ok: true }))
  };
}

function parseFramedMessage(buffer) {
  const length = buffer.readInt32BE(0);
  const payload = buffer.slice(4, 4 + length).toString('utf8');
  return JSON.parse(payload);
}
