import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { extractState, isRecoverablePlayModeDisconnect, pollEditorState, recoverPlayModeState } from './playModeRecovery.js';

/**
 * Handler for stopping Unity play mode
 */
export class StopToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'stop_game',
      'Stop Unity play mode and return to edit mode',
      {
        type: 'object',
        properties: {},
        required: []
      }
    );
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the stop command
   * @param {object} params - Empty object for this command
   * @returns {Promise<object>} Play mode state
   */
  async execute(params) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      throw new Error('Unity connection not available');
    }
    
    let result;
    try {
      result = await this.unityConnection.sendCommand('stop_game', params);
    } catch (error) {
      if (isRecoverablePlayModeDisconnect(error)) {
        result = await recoverPlayModeState(this.unityConnection, 'Exited play mode after reconnect');
      } else {
        throw error;
      }
    }
    
    // Check for Unity-side errors
    if (result.status === 'error') {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }
    
    const state = extractState(result);
    if (state.isPlaying === true) {
      const finalState = await pollEditorState(
        this.unityConnection,
        (candidateState) => candidateState.isPlaying === false
      );

      return {
        ...result,
        status: 'success',
        message: result.message || 'Exited play mode',
        state: finalState.state,
        polledUntilFinalState: !finalState.timedOut,
        transitional: finalState.timedOut
      };
    }

    return result;
  }
}
