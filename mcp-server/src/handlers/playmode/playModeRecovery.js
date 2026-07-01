import { config } from '../../core/config.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PLAY_RECOVERY_TIMEOUT_MS = config.playModeRecovery.timeoutMs;
export const STOP_TRANSITION_TIMEOUT_MS = config.playModeRecovery.stopTransitionTimeoutMs;
export const PLAY_MODE_POLL_INTERVAL_MS = config.playModeRecovery.pollIntervalMs;
export const PLAY_MODE_STATE_COMMAND_TIMEOUT_MS = config.playModeRecovery.stateCommandTimeoutMs;

export function isRecoverablePlayModeDisconnect(error) {
  return error?.message === 'Connection closed' ||
    error?.message === 'Connection timeout' ||
    error?.message === 'Command timeout' ||
    error?.message === 'Not connected to Unity' ||
    error?.message === 'Unity connection not available' ||
    error?.message === 'AUTH_FAILED' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'ECONNREFUSED' ||
    error?.code === 'EPIPE' ||
    error?.code === 'AUTH_FAILED' ||
    error?.code === 'COMMAND_TIMEOUT' ||
    error?.code === 'NOT_CONNECTED' ||
    error?.code === 'CONNECTION_CLOSED' ||
    error?.code === 'NO_UNITY_INSTANCE' ||
    error?.code === 'LOCAL_WORKSPACE_MISMATCH';
}

export async function recoverPlayModeState(unityConnection, message, options = {}) {
  const verified = await waitForEditorState(
    unityConnection,
    (state) => isPlayModeUsable(state),
    {
      timeoutMs: options.timeoutMs ?? PLAY_RECOVERY_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? PLAY_MODE_POLL_INTERVAL_MS,
      commandTimeoutMs: options.commandTimeoutMs,
      timeoutCode: 'PLAY_MODE_RECOVERY_TIMEOUT',
      timeoutMessage: 'Timed out waiting for Unity to enter play mode after reconnect',
      connectBeforeFirstPoll: true
    }
  );

  return {
    status: 'success',
    message,
    recoveredAfterReconnect: true,
    state: verified.state,
    attempts: verified.attempts,
    elapsedMs: verified.elapsedMs,
    recoveryActions: verified.recoveryActions
  };
}

export function isPlayModeUsable(state) {
  if (state?.isPlaying !== true || state?.isPaused === true) {
    return false;
  }

  if (state.isPlayerLoopAdvancing === false) {
    return false;
  }

  if (state.isPlayerLoopAdvancing === true) {
    return true;
  }

  if (state.frameCount !== undefined || state.time !== undefined) {
    return Number(state.frameCount || 0) > 1 && Number(state.time || 0) > 0;
  }

  return true;
}

export async function waitForEditorState(unityConnection, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? STOP_TRANSITION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PLAY_MODE_POLL_INTERVAL_MS;
  const timeoutCode = options.timeoutCode || 'EDITOR_STATE_TIMEOUT';
  const timeoutMessage = options.timeoutMessage || 'Timed out waiting for Unity editor state';
  const startedAt = Date.now();
  let attempts = 0;
  let lastState = null;
  let shouldConnect = options.connectBeforeFirstPoll === true;
  let activatedUnity = false;
  const recoveryActions = [];

  do {
    if (shouldConnect) {
      try {
        attempts++;
        await unityConnection.connect();
        shouldConnect = false;
      } catch (error) {
        if (!isRecoverablePlayModeDisconnect(error)) {
          throw error;
        }

        throwIfTimedOut(timeoutCode, timeoutMessage, {
          startedAt,
          timeoutMs,
          lastState,
          attempts
        });
        await sleep(pollIntervalMs);
        continue;
      }
    }

    try {
      attempts++;
      const result = await unityConnection.sendCommand('get_editor_state', {}, {
        timeoutMs: getStatePollCommandTimeoutMs({
          startedAt,
          timeoutMs,
          commandTimeoutMs: options.commandTimeoutMs
        })
      });
      if (result?.status === 'error') {
        const error = new Error(result.error || 'Failed to get Unity editor state');
        error.code = 'UNITY_ERROR';
        throw error;
      }

      const state = extractState(result);
      lastState = state;

      if (predicate(state, result)) {
        return {
          result,
          state,
          attempts,
          elapsedMs: Date.now() - startedAt,
          recoveryActions
        };
      }

      if (!activatedUnity && shouldActivateUnityOnFrozenPlayMode(state, attempts, options)) {
        activatedUnity = true;
        recoveryActions.push(await activateUnityEditor(options));
      }
    } catch (error) {
      if (!isRecoverablePlayModeDisconnect(error)) {
        throw error;
      }

      shouldConnect = true;
    }

    throwIfTimedOut(timeoutCode, timeoutMessage, {
      startedAt,
      timeoutMs,
      lastState,
      attempts
    });

    await sleep(pollIntervalMs);
  } while (true);
}

export async function pollEditorState(unityConnection, predicate, options = {}) {
  return waitForEditorState(unityConnection, predicate, options);
}

export function extractState(result) {
  return result?.state || result || {};
}

function getStatePollCommandTimeoutMs({ startedAt, timeoutMs, commandTimeoutMs }) {
  const elapsedMs = Date.now() - startedAt;
  const remainingMs = Math.max(1, timeoutMs - elapsedMs);
  const requestedMs = commandTimeoutMs ?? PLAY_MODE_STATE_COMMAND_TIMEOUT_MS;
  return Math.max(1, Math.min(requestedMs, remainingMs));
}

function createStateTimeoutError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function throwIfTimedOut(code, message, { startedAt, timeoutMs, lastState, attempts }) {
  if (Date.now() - startedAt < timeoutMs) {
    return;
  }

  throw createStateTimeoutError(code, message, {
    lastState,
    attempts,
    elapsedMs: Date.now() - startedAt
  });
}

function shouldActivateUnityOnFrozenPlayMode(state, attempts, options = {}) {
  const enabled = options.activateUnityOnFreeze ?? config.playModeRecovery.activateUnityOnFreeze;
  if (!enabled || attempts < 2) {
    return false;
  }

  return state?.isPlaying === true &&
    state?.isPaused !== true &&
    state?.isPlayerLoopAdvancing !== true &&
    Number(state?.frameCount || 0) <= 1 &&
    Number(state?.time || 0) === 0;
}

async function activateUnityEditor(options = {}) {
  const action = {
    type: 'activate_unity_editor',
    platform: process.platform
  };

  if (typeof options.activateUnityEditor === 'function') {
    try {
      await options.activateUnityEditor();
      return { ...action, status: 'success', source: 'custom' };
    } catch (error) {
      return { ...action, status: 'failed', source: 'custom', error: error.message };
    }
  }

  if (process.platform !== 'darwin') {
    return { ...action, status: 'skipped', reason: 'not_macos' };
  }

  try {
    await execFileAsync('osascript', ['-e', 'tell application "Unity" to activate'], {
      timeout: 2000
    });
    return { ...action, status: 'success', source: 'osascript' };
  } catch (error) {
    return { ...action, status: 'failed', source: 'osascript', error: error.message };
  }
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
