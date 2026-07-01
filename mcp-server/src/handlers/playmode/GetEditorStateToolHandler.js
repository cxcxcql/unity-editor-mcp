import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { PLAY_MODE_POLL_INTERVAL_MS, waitForEditorState } from './playModeRecovery.js';
import { getServerMetadata } from '../../core/serverMetadata.js';
import { config } from '../../core/config.js';
import { readDaemonRegistry, summarizeDaemonRegistry } from '../../core/daemonRegistry.js';

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
    
    return {
      ...result,
      server: getServerMetadata(),
      connection: this.unityConnection.getConnectionInfo ? this.unityConnection.getConnectionInfo() : undefined,
      daemon: await getDaemonSourceMetadata(),
      recovery: {
        attempts: verified.attempts,
        elapsedMs: verified.elapsedMs,
        usedPolling: verified.attempts > 1,
        recoveryActions: verified.recoveryActions
      }
    };
  }
}

async function getDaemonSourceMetadata() {
  const registry = await readDaemonRegistry({ registryDir: config.daemon.registryDir }).catch(() => null);
  const summary = summarizeDaemonRegistry(registry, {
    staleAfterMs: config.daemon.staleAfterMs
  });
  const lastSeenMs = registry?.lastSeen ? Date.parse(registry.lastSeen) : NaN;

  return {
    ...summary,
    registryAgeMs: Number.isFinite(lastSeenMs) ? Date.now() - lastSeenMs : null
  };
}
