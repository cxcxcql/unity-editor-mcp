const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_MAX_MESSAGES = 50;

export async function waitForCompilation(unityConnection, options = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const settleMs = nonNegativeNumber(options.settleMs, DEFAULT_SETTLE_MS);
  const includeMessages = options.includeMessages !== false;
  const maxMessages = positiveNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  let latestState = null;
  let stableSince = null;
  let lastRetryableError = null;

  while (Date.now() <= deadline) {
    try {
      latestState = await getCompilationState(unityConnection, {
        includeMessages: false,
        maxMessages
      });
      lastRetryableError = null;

      if (!latestState.isCompiling && !latestState.isUpdating) {
        if (stableSince === null) {
          stableSince = Date.now();
        }

        if (Date.now() - stableSince >= settleMs) {
          const finalState = includeMessages
            ? await getCompilationState(unityConnection, {
              includeMessages: true,
              maxMessages
            }, deadline)
            : latestState;

          return buildResult(finalState, startedAt, {
            completed: true,
            timedOut: false
          });
        }
      } else {
        stableSince = null;
      }
    } catch (error) {
      if (!isRetryableConnectionError(error) || Date.now() >= deadline) {
        throw error;
      }

      lastRetryableError = error;
      const reconnectError = await tryReconnect(unityConnection);
      if (reconnectError) {
        lastRetryableError = reconnectError;
      }
      stableSince = null;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return buildResult(latestState || {}, startedAt, {
    completed: false,
    timedOut: true,
    lastError: lastRetryableError?.message
  });
}

async function getCompilationState(unityConnection, params, deadline = Infinity) {
  while (Date.now() <= deadline) {
    try {
      if (!unityConnection.isConnected()) {
        await unityConnection.connect();
      }

      return await unityConnection.sendCommand('get_compilation_state', params);
    } catch (error) {
      if (!isRetryableConnectionError(error) || Date.now() >= deadline) {
        throw error;
      }

      const reconnectError = await tryReconnect(unityConnection);
      if (reconnectError && Date.now() >= deadline) {
        throw reconnectError;
      }
      if (reconnectError) {
        await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
      }
    }
  }

  throw new Error('Timed out waiting for Unity compilation state');
}

async function reconnect(unityConnection) {
  if (typeof unityConnection.disconnect === 'function') {
    unityConnection.disconnect();
  }
  await unityConnection.connect();
}

async function tryReconnect(unityConnection) {
  try {
    await reconnect(unityConnection);
    return null;
  } catch (error) {
    if (!isRetryableConnectionError(error)) {
      throw error;
    }
    return error;
  }
}

function buildResult(state, startedAt, status) {
  return {
    success: status.completed && !status.timedOut,
    completed: status.completed,
    timedOut: status.timedOut,
    elapsedMs: Date.now() - startedAt,
    isCompiling: state.isCompiling ?? false,
    isUpdating: state.isUpdating ?? false,
    isMonitoring: state.isMonitoring,
    lastCompilationTime: state.lastCompilationTime,
    messageCount: state.messageCount ?? 0,
    errorCount: state.errorCount ?? 0,
    warningCount: state.warningCount ?? 0,
    ...(state.messages !== undefined && { messages: state.messages }),
    ...(status.lastError && { lastError: status.lastError })
  };
}

function isRetryableConnectionError(error) {
  const message = error?.message || '';
  const code = error?.code || '';
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    message.includes('Connection closed') ||
    message.includes('Connection timeout') ||
    message.includes('Command timeout') ||
    message.includes('Not connected to Unity')
  );
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
