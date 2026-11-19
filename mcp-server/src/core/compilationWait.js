const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_SETTLE_MS = 1000;
const DEFAULT_MAX_MESSAGES = 50;
const EDITOR_PROBE_TIMEOUT_MS = 2000;

export async function waitForCompilation(unityConnection, options = {}, context = {}) {
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const settleMs = nonNegativeNumber(options.settleMs, DEFAULT_SETTLE_MS);
  const includeMessages = options.includeMessages !== false;
  const maxMessages = positiveNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const signal = context.signal;

  let latestState = null;
  let unityStatus = null;
  let stableSince = null;
  let lastRetryableError = null;
  let reconnect = false;

  while (Date.now() < deadline) {
    throwIfCancelled(signal);

    try {
      unityStatus = typeof unityConnection.getUnityStatus === 'function'
        ? await beforeDeadline(() => unityConnection.getUnityStatus(), deadline, signal)
        : null;
      const preferEditorState = !unityStatus || unityStatus.activityTracking === false ||
        (unityStatus.activityTracking === null && unityConnection.isConnected());

      if (preferEditorState) {
        // Legacy editors publish no activity file. Continue to support their TCP state tool.
        latestState = await getCompilationState(unityConnection, false, maxMessages, deadline, signal, reconnect);
        reconnect = false;
      } else {
        latestState = {
          isCompiling: unityStatus.state === 'compiling',
          isUpdating: unityStatus.source === 'unity.assetRefresh'
        };
      }

      await sendProgress(context, startedAt, timeoutMs, latestState, unityStatus);

      const mayBeReady = preferEditorState
        ? !latestState.isCompiling && !latestState.isUpdating
        : unityStatus.state === 'ready';
      if (mayBeReady) {
        stableSince ??= Date.now();

        if (Date.now() - stableSince >= settleMs) {
          // Even a fresh ready snapshot predates this request. Confirm the editor can execute a read now.
          const finalState = !preferEditorState || includeMessages
            ? await getCompilationState(unityConnection, includeMessages, maxMessages, deadline, signal, reconnect)
            : latestState;
          latestState = finalState;
          reconnect = false;

          if (!finalState.isCompiling && !finalState.isUpdating) {
            return buildResult(finalState, startedAt, { completed: true, timedOut: false, unityStatus });
          }
          stableSince = null;
        }
      } else {
        stableSince = null;
      }
      lastRetryableError = null;
    } catch (error) {
      if (error.code === 'WAIT_FOR_COMPILATION_TIMEOUT') {
        lastRetryableError = error;
        break;
      }
      if (!isRetryableConnectionError(error)) {
        throw error;
      }
      lastRetryableError = error;
      reconnect = error.code !== 'UNITY_BUSY';
      stableSince = null;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), signal);
  }

  return buildResult(latestState || {}, startedAt, {
    completed: false,
    timedOut: true,
    lastError: lastRetryableError?.message,
    unityStatus
  });
}

async function getCompilationState(connection, includeMessages, maxMessages, deadline, signal, reconnect) {
  if (reconnect || !connection.isConnected()) {
    await beforeDeadline(() => connection.connect(), deadline, signal);
  }

  return beforeDeadline(() => connection.sendCommand('get_compilation_state', { includeMessages, maxMessages }, {
    signal,
    deadlineUnixMs: deadline,
    timeoutMs: EDITOR_PROBE_TIMEOUT_MS
  }), deadline, signal);
}

async function beforeDeadline(operation, deadline, signal) {
  throwIfCancelled(signal);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createWaitTimeoutError();
  }

  let timeout;
  let onAbort;
  try {
    const interrupted = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(createWaitTimeoutError()), remainingMs);
      onAbort = () => reject(createCancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([operation(), interrupted]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function createWaitTimeoutError() {
  const error = new Error('Timed out waiting for Unity compilation state');
  error.code = 'WAIT_FOR_COMPILATION_TIMEOUT';
  return error;
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
    ...(status.unityStatus && { unityStatus: status.unityStatus }),
    ...(status.lastError && { lastError: status.lastError })
  };
}

function isRetryableConnectionError(error) {
  const message = error?.message || '';
  const code = error?.code || '';
  return (
    code === 'UNITY_BUSY' ||
    code === 'UNITY_STATUS_UNVERIFIED' ||
    code === 'UNITY_REQUEST_EXPIRED' ||
    code === 'COMMAND_TIMEOUT' ||
    code === 'AUTH_FAILED' ||
    code === 'NOT_CONNECTED' ||
    code === 'NO_UNITY_INSTANCE' ||
    code === 'LOCAL_WORKSPACE_MISMATCH' ||
    code === 'CONNECTION_CLOSED' ||
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

async function sendProgress(context, startedAt, timeoutMs, state, unityStatus) {
  if (typeof context.sendProgress !== 'function') {
    return;
  }
  const elapsed = Date.now() - startedAt;
  const message = unityStatus?.message || (
    state.isCompiling ? 'Waiting for Unity compilation'
      : state.isUpdating ? 'Waiting for Unity asset refresh'
        : 'Waiting for Unity editor settle window'
  );
  await context.sendProgress({ progress: Math.min(elapsed, timeoutMs), total: timeoutMs, message });
}

function createCancelledError() {
  const error = new Error('Request cancelled');
  error.code = 'REQUEST_CANCELLED';
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw createCancelledError();
  }
}

function sleep(ms, signal) {
  throwIfCancelled(signal);
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(createCancelledError());
    };
    const timeout = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
