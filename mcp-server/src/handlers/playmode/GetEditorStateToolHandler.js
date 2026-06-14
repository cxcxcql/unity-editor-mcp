import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { PLAY_MODE_POLL_INTERVAL_MS, waitForEditorState } from './playModeRecovery.js';

const EDITOR_STATE_RECOVERY_TIMEOUT_MS = 10000;

/**
 * Handler for getting Unity editor state
 */
export class GetEditorStateToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'get_editor_state',
      'Get current Unity editor state including play mode status',
      {
        type: 'object',
        properties: {},
        required: []
      }
    );
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the get editor state command
   * @param {object} params - Empty object for this command
   * @returns {Promise<object>} Editor state information
   */
  async execute(params, context = {}) {
    const verified = await waitForEditorState(
      this.unityConnection,
      () => true,
      {
        timeoutMs: context.editorStateRecovery?.timeoutMs ??
          context.playModeRecovery?.timeoutMs ??
          EDITOR_STATE_RECOVERY_TIMEOUT_MS,
        pollIntervalMs: context.editorStateRecovery?.pollIntervalMs ??
          context.playModeRecovery?.pollIntervalMs ??
          PLAY_MODE_POLL_INTERVAL_MS,
        timeoutCode: 'EDITOR_STATE_RECOVERY_TIMEOUT',
        timeoutMessage: 'Timed out waiting for Unity editor state after reconnect',
        connectBeforeFirstPoll: !this.unityConnection.isConnected()
      }
    );
    const result = verified.result;
    
    // Check for Unity-side errors
    if (result.status === 'error') {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }
    
    // Return the state information
    return result;
  }
}
