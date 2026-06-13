import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { waitForCompilation } from '../../core/compilationWait.js';

/**
 * Handler for the refresh_assets tool
 * Triggers Unity to refresh assets and potentially recompile
 */
export class RefreshAssetsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'refresh_assets',
      'Trigger Unity to refresh assets and check for compilation',
      {
        type: 'object',
        properties: {
          waitForCompletion: {
            type: 'boolean',
            description: 'Wait for Unity compilation and asset updating to settle after refresh'
          },
          timeoutMs: {
            type: 'number',
            description: 'Maximum time to wait in milliseconds when waitForCompletion is true'
          },
          pollIntervalMs: {
            type: 'number',
            description: 'Polling interval in milliseconds when waitForCompletion is true'
          },
          settleMs: {
            type: 'number',
            description: 'Stable non-compiling/non-updating window before completion'
          },
          includeMessages: {
            type: 'boolean',
            description: 'Fetch detailed compilation messages after completion'
          },
          maxMessages: {
            type: 'number',
            description: 'Maximum number of detailed messages to return'
          }
        },
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the refresh_assets command
   * @param {object} params - Input parameters (none required)
   * @returns {Promise<object>} Refresh result
   */
  async execute(params, context) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }
    
    // Send refresh_assets command
    await context?.sendProgress?.({
      progress: 0,
      total: 1,
      message: 'Requesting Unity asset refresh'
    });

    const result = await this.unityConnection.sendCommand('refresh_assets', {});
    const compilation = params.waitForCompletion
      ? await waitForCompilation(this.unityConnection, params, context)
      : undefined;

    await context?.sendProgress?.({
      progress: 1,
      total: 1,
      message: 'Unity asset refresh request complete'
    });
    
    return {
      message: result.message,
      isCompiling: result.isCompiling,
      timestamp: result.timestamp,
      note: result.isCompiling 
        ? 'Unity is compiling. New commands will be available after compilation completes.'
        : 'Asset refresh complete. Unity is not currently compiling.',
      ...(compilation && { compilation })
    };
  }
}
