import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { findByComponentToolDefinition } from '../../tools/analysis/findByComponent.js';

/**
 * Handler for the find_by_component tool
 */
export class FindByComponentToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      findByComponentToolDefinition.name,
      findByComponentToolDefinition.description,
      findByComponentToolDefinition.inputSchema
    );
    this.unityConnection = unityConnection;
  }

  async execute(args) {
    if (!this.unityConnection.isConnected()) {
      throw new Error('Unity connection not available');
    }

    const result = await this.unityConnection.sendCommand('find_by_component', args);
    if (result?.error) {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }

    return result;
  }
}
