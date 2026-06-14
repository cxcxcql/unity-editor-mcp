import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { isRecoverablePlayModeDisconnect, recoverPlayModeState } from './playModeRecovery.js';

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
        properties: {},
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
    
    // Return the result with state information
    return result;
  }
}
