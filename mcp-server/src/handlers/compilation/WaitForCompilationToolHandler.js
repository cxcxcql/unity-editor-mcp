import { waitForCompilation } from '../../core/compilationWait.js';
import { BaseToolHandler } from '../base/BaseToolHandler.js';

export class WaitForCompilationToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'wait_for_compilation',
      'Wait for Unity compilation and asset updating to settle',
      {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'number',
            description: 'Maximum time to wait in milliseconds (default: 120000)'
          },
          pollIntervalMs: {
            type: 'number',
            description: 'Polling interval in milliseconds (default: 500)'
          },
          settleMs: {
            type: 'number',
            description: 'Stable non-compiling/non-updating window before completion (default: 1000)'
          },
          includeMessages: {
            type: 'boolean',
            description: 'Fetch detailed compilation messages once after completion (default: true)'
          },
          maxMessages: {
            type: 'number',
            description: 'Maximum number of detailed messages to return (default: 50)'
          }
        },
        required: []
      }
    );

    this.unityConnection = unityConnection;
  }

  async execute(params) {
    return waitForCompilation(this.unityConnection, params);
  }
}
