const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 2000;

export function isRecoverablePlayModeDisconnect(error) {
  return error?.message === 'Connection closed' ||
    error?.code === 'ECONNRESET' ||
    error?.code === 'EPIPE';
}

export async function recoverPlayModeState(unityConnection, message) {
  await unityConnection.connect();
  const stateResult = await unityConnection.sendCommand('get_editor_state', {});
  const state = extractState(stateResult);

  return {
    status: 'success',
    message,
    recoveredAfterReconnect: true,
    state
  };
}

export async function pollEditorState(unityConnection, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let lastResult = null;

  do {
    lastResult = await unityConnection.sendCommand('get_editor_state', {});
    const state = extractState(lastResult);
    if (predicate(state, lastResult)) {
      return {
        result: lastResult,
        state,
        timedOut: false
      };
    }

    if (Date.now() - startedAt >= timeoutMs) {
      return {
        result: lastResult,
        state,
        timedOut: true
      };
    }

    await sleep(pollIntervalMs);
  } while (true);
}

export function extractState(result) {
  return result?.state || result || {};
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
