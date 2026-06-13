import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GetComponentValuesToolHandler } from '../../../src/handlers/analysis/GetComponentValuesToolHandler.js';
import { createMockUnityConnection } from '../../utils/test-helpers.js';

describe('GetComponentValuesToolHandler', () => {
  let handler;
  let mockConnection;

  beforeEach(() => {
        mockConnection = createMockUnityConnection({
      sendCommandResult: {
        status: 'success',
        result: {
          componentType: "Light",
          values: {
            intensity: 1.5,
            color: {r: 1, g: 1, b: 1, a: 1}
          },
          summary: "Light component on TestObject"
        }
      }
    });
    handler = new GetComponentValuesToolHandler(mockConnection);
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      assert.ok(handler.name);
      assert.ok(handler.description);
      assert.deepEqual(handler.inputSchema.required, ["gameObjectName", "componentType"]);
    });
  });

  describe('validate', () => {
    it('should pass with valid parameters', () => {
      assert.doesNotThrow(() => handler.validate({"gameObjectName":"TestObject","componentType":"Transform"}));
    });

    it('should fail with missing required parameter', () => {
      assert.throws(
        () => handler.validate({}),
        /Missing required parameter: gameObjectName/
      );
    });
    it('should fail with missing componentType', () => {
      assert.throws(
        () => handler.validate({"gameObjectName":"Test"}),
        /Missing required parameter: componentType/
      );
    });
  });

    describe('execute', () => {
    it('should execute successfully with valid params', async () => {
      const result = await handler.execute({"gameObjectName":"TestObject","componentType":"Light"});
      
      assert.equal(mockConnection.sendCommand.mock.calls.length, 1);
      assert.ok(result);
      assert.equal(result.componentType, "Light");
      assert.ok(result.summary.includes("Light component"));
    });

    it('should return error if not connected', async () => {
      mockConnection.isConnected.mock.mockImplementation(() => false);
      
      await assert.rejects(
        async () => await handler.execute({"gameObjectName":"TestObject","componentType":"Light"}),
        /Unity connection not available/
      );
    });
  });

  describe('integration with BaseToolHandler', () => {
    it('should handle valid request through handle method', async () => {
      const result = await handler.handle({"gameObjectName":"TestObject","componentType":"Transform"});
      
      assert.equal(result.status, 'success');
      assert.ok(result.result);
      assert.equal(result.result.componentType, "Light");
      assert.ok(result.result.summary.includes("Light component"));
    });

    it('should return error for validation failure', async () => {
      const result = await handler.handle({});
      
      assert.equal(result.status, 'error');
      assert.match(result.error, /Missing required parameter: gameObjectName/);
    });
  });
});
