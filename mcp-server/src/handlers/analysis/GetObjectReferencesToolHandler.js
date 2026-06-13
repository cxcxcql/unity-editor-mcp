import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { getObjectReferencesToolDefinition } from '../../tools/analysis/getObjectReferences.js';

/**
 * Handler for the get_object_references tool
 */
export class GetObjectReferencesToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      getObjectReferencesToolDefinition.name,
      getObjectReferencesToolDefinition.description,
      getObjectReferencesToolDefinition.inputSchema
    );
    this.unityConnection = unityConnection;
  }

  async execute(args) {
    if (!this.unityConnection.isConnected()) {
      throw new Error('Unity connection not available');
    }

    const result = await this.unityConnection.sendCommand('get_object_references', args);
    if (result?.error) {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }

    return result;
  }
}
