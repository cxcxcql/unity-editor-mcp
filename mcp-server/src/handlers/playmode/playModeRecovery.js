export const PLAY_RECOVERY_TIMEOUT_MS = 15000;
export const STOP_TRANSITION_TIMEOUT_MS = 10000;
export const PLAY_MODE_POLL_INTERVAL_MS = 250;

export function isRecoverablePlayModeDisconnect(error) {
  return error?.message === 'Connection closed' ||
    error?.message === 'Connection timeout' ||
    error?.message === 'Not connected to Unity' ||
    error?.message === 'Unity connection not available' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'EPIPE' ||
    error?.code === 'NOT_CONNECTED' ||
    error?.code === 'CONNECTION_CLOSED' ||
    error?.code === 'NO_UNITY_INSTANCE' ||
    error?.code === 'LOCAL_WORKSPACE_MISMATCH';
}

export async function recoverPlayModeState(unityConnection, message, options = {}) {
  const verified = await waitForEditorState(
    unityConnection,
    (state) => state.isPlaying === true,
    {
      timeoutMs: options.timeoutMs ?? PLAY_RECOVERY_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? PLAY_MODE_POLL_INTERVAL_MS,
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
    elapsedMs: verified.elapsedMs
  };
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
      const result = await unityConnection.sendCommand('get_editor_state', {});
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
          elapsedMs: Date.now() - startedAt
        };
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

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
