import { BaseToolHandler } from '../base/BaseToolHandler.js';
import {
  STOP_TRANSITION_TIMEOUT_MS,
  extractState,
  isRecoverablePlayModeDisconnect,
  waitForEditorState
} from './playModeRecovery.js';

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
  async execute(params, context = {}) {
    // Ensure connected
    if (!this.unityConnection.isConnected()) {
      throw new Error('Unity connection not available');
    }
    
    let result;
    try {
      result = await this.unityConnection.sendCommand('stop_game', params);
    } catch (error) {
      if (isRecoverablePlayModeDisconnect(error)) {
        const verified = await waitForEditorState(
          this.unityConnection,
          (candidateState) => candidateState.isPlaying === false,
          {
            timeoutMs: context.playModeRecovery?.timeoutMs ?? STOP_TRANSITION_TIMEOUT_MS,
            pollIntervalMs: context.playModeRecovery?.pollIntervalMs,
            timeoutCode: 'STOP_MODE_TRANSITION_TIMEOUT',
            timeoutMessage: 'Timed out waiting for Unity to exit play mode after reconnect',
            connectBeforeFirstPoll: true
          }
        );

        return {
          status: 'success',
          message: 'Exited play mode after reconnect',
          recoveredAfterReconnect: true,
          state: verified.state,
          attempts: verified.attempts,
          elapsedMs: verified.elapsedMs,
          polledUntilFinalState: true
        };
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
      const finalState = await waitForEditorState(
        this.unityConnection,
        (candidateState) => candidateState.isPlaying === false,
        {
          timeoutMs: context.playModeRecovery?.timeoutMs ?? STOP_TRANSITION_TIMEOUT_MS,
          pollIntervalMs: context.playModeRecovery?.pollIntervalMs,
          timeoutCode: 'STOP_MODE_TRANSITION_TIMEOUT',
          timeoutMessage: 'Timed out waiting for Unity to exit play mode'
        }
      );

      return {
        ...result,
        status: 'success',
        message: result.message || 'Exited play mode',
        state: finalState.state,
        polledUntilFinalState: true,
        attempts: finalState.attempts,
        elapsedMs: finalState.elapsedMs
      };
    }

    return result;
  }
}
