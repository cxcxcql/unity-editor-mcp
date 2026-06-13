import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { getComponentValuesToolDefinition } from '../../tools/analysis/getComponentValues.js';

/**
 * Handler for the get_component_values tool
 */
export class GetComponentValuesToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      getComponentValuesToolDefinition.name,
      getComponentValuesToolDefinition.description,
      getComponentValuesToolDefinition.inputSchema
    );
    this.unityConnection = unityConnection;
  }

  async execute(args) {
    if (!this.unityConnection.isConnected()) {
      throw new Error('Unity connection not available');
    }

    const result = await this.unityConnection.sendCommand('get_component_values', args);

    if (!result || typeof result === 'string') {
      throw new Error('Invalid response format');
    }

    if (result.error) {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }

    return result;
  }
}
