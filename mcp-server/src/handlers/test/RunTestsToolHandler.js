import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for running tests in Unity
 */
export class RunTestsToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'run_tests',
      'Run tests in Unity Test Runner',
      {
        type: 'object',
        properties: {
          testMode: {
            type: 'string',
            description: 'Test mode to run (EditMode, PlayMode, or EditAndPlayMode)',
            enum: ['EditMode', 'PlayMode', 'EditAndPlayMode']
          },
          testNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific test names to run (runs all if not specified)'
          },
          runAll: {
            type: 'boolean',
            description: 'Run all tests in the specified mode',
            default: false
          },
          includeCategories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Include tests with these categories'
          },
          excludeCategories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exclude tests with these categories'
          }
        },
        required: []
      }
    );
    
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the run tests command
   * @param {object} params - Input parameters
   * @returns {Promise<object>} Test execution status
   */
  async execute(params, context) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }

    if (context?.signal?.aborted) {
      const error = new Error('Request cancelled');
      error.code = 'REQUEST_CANCELLED';
      throw error;
    }

    await context?.sendProgress?.({
      progress: 0,
      total: 1,
      message: 'Starting Unity test run'
    });
    
    // Send run tests command
    const result = await this.unityConnection.sendCommand('run_tests', {
      testMode: params.testMode,
      testNames: params.testNames,
      runAll: params.runAll,
      includeCategories: params.includeCategories,
      excludeCategories: params.excludeCategories
    });

    if (context?.signal?.aborted) {
      const error = new Error('Request cancelled');
      error.code = 'REQUEST_CANCELLED';
      throw error;
    }

    await context?.sendProgress?.({
      progress: 1,
      total: 1,
      message: 'Unity test run request complete'
    });
    
    return result;
  }
}
