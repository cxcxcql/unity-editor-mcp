import { BaseToolHandler } from '../base/BaseToolHandler.js';
import {
  PLAY_MODE_POLL_INTERVAL_MS,
  extractState,
  isPlayModeUsable,
  isRecoverablePlayModeDisconnect,
  recoverPlayModeState,
  waitForEditorState
} from './playModeRecovery.js';

/**
 * Handler for starting Unity play mode
 */
export class PlayToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'play_game',
      'Start Unity play mode to test the game',
      {
        type: 'object',
        properties: {
          waitForPlayerLoop: {
            type: 'boolean',
            description: 'Wait until Unity reports the player loop is advancing before returning (default: true)'
          }
        },
        required: []
      }
    );
    this.unityConnection = unityConnection;
  }

  /**
   * Executes the play command
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
      result = await this.unityConnection.sendCommand('play_game', params);
    } catch (error) {
      if (isRecoverablePlayModeDisconnect(error)) {
        return recoverPlayModeState(
          this.unityConnection,
          'Entered play mode after reconnect',
          context.playModeRecovery
        );
      }
      throw error;
    }
    
    // Check for Unity-side errors
    if (result.status === 'error') {
      const error = new Error(result.error);
      error.code = 'UNITY_ERROR';
      throw error;
    }
    
    const state = extractState(result);
    const shouldWaitForPlayerLoop = params.waitForPlayerLoop !== false;
    if (shouldWaitForPlayerLoop && state.isPlaying === true && !isPlayModeUsable(state)) {
      const verified = await waitForEditorState(
        this.unityConnection,
        (candidateState) => isPlayModeUsable(candidateState),
        {
          timeoutMs: context.playModeRecovery?.timeoutMs,
          pollIntervalMs: context.playModeRecovery?.pollIntervalMs ?? PLAY_MODE_POLL_INTERVAL_MS,
          commandTimeoutMs: context.playModeRecovery?.commandTimeoutMs,
          timeoutCode: 'PLAY_MODE_PLAYER_LOOP_TIMEOUT',
          timeoutMessage: 'Timed out waiting for Unity player loop to advance after entering play mode'
        }
      );

      return {
        ...result,
        state: verified.state,
        polledUntilPlayerLoopAdvancing: true,
        attempts: verified.attempts,
        elapsedMs: verified.elapsedMs,
        recoveryActions: verified.recoveryActions
      };
    }

    return result;
  }
}
