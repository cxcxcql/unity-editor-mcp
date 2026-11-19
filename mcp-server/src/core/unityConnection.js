import net from 'net';
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import { config, logger } from './config.js';
import { resolveUnityEndpoint, readUnityInstances } from './unityDiscovery.js';
import { createUnityBusyError, getUnityStatus } from './unityStatus.js';

const commandContext = new AsyncLocalStorage();

export function withUnityCommandSignal(signal, operation) {
  return commandContext.run({ signal, mayHaveStarted: false }, operation);
}

export function unityCommandMayHaveStarted() {
  return commandContext.getStore()?.mayHaveStarted === true;
}

/**
 * Manages TCP connection to Unity Editor
 */
export class UnityConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || config;
    this.socketFactory = options.socketFactory || (() => new net.Socket());
    this.socket = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.commandId = 0;
    this.pendingCommands = new Map();
    this.commandQueue = [];
    this.commandInFlight = false;
    this.connectPromise = null;
    this.connectionGeneration = 0;
    this.activeConnectReject = null;
    this.isDisconnecting = false;
    this.messageBuffer = Buffer.alloc(0);
    this.endpoint = null;
  }

  /**
   * Connects to Unity Editor
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.connected) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectOnce() {
    // Skip connection in CI/test environments
    if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
      logger.info('Skipping Unity connection in test/CI environment');
      throw new Error('Unity connection disabled in test environment');
    }

    const generation = this.connectionGeneration;
    const endpoint = await this.resolveEndpoint({
      validate: () => {
        if (generation !== this.connectionGeneration) {
          throw createConnectionClosedError();
        }
      }
    });

    return new Promise((resolve, reject) => {
      logger.info(`Connecting to Unity at ${endpoint.host}:${endpoint.port} (${endpoint.source})...`);
      
      this.socket = this.socketFactory();
      let connectionTimeout = null;
      let resolved = false;
      
      // Helper to clean up the connection timeout
      const clearConnectionTimeout = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
      };

      const rejectConnect = (error) => {
        if (resolved) {
          return;
        }

        resolved = true;
        clearConnectionTimeout();
        this.activeConnectReject = null;
        reject(error);
      };

      const resolveConnect = () => {
        if (resolved) {
          return;
        }

        resolved = true;
        clearConnectionTimeout();
        this.activeConnectReject = null;
        resolve();
      };

      this.activeConnectReject = rejectConnect;
      
      // Set up event handlers
      this.socket.on('connect', () => {
        logger.info('Connected to Unity Editor');
        this.connected = true;
        this.isDisconnecting = false;
        this.reconnectAttempts = 0;
        this.emit('connected');
        resolveConnect();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        logger.error('Socket error:', error.message);
        this.emitConnectionError(error);
        
        if (!this.connected && !resolved) {
          // Mark as disconnecting to prevent reconnection
          this.isDisconnecting = true;
          // Destroy the socket to clean up properly
          this.socket.destroy();
          this.isDisconnecting = false;
          // Re-discover on the next reconnect rather than reusing a stale endpoint.
          this.endpoint = null;
          this.rejectQueuedCommands(createConnectionClosedError(error.message || 'Connection failed'));
          rejectConnect(error);
        }
      });

      this.socket.on('close', () => {
        // Clear the connection timeout when socket closes
        clearConnectionTimeout();

        if (!this.connected && !resolved) {
          const closeError = createConnectionClosedError();
          this.connected = false;
          this.socket = null;
          this.messageBuffer = Buffer.alloc(0);
          this.endpoint = null;
          this.rejectQueuedCommands(closeError);
          rejectConnect(closeError);

          if (!this.isDisconnecting && this.shouldAutoReconnect()) {
            this.scheduleReconnect();
          }
          return;
        }
        
        // Check if we're already handling disconnection
        if (this.isDisconnecting || !this.socket) {
          return;
        }
        
        logger.info('Disconnected from Unity Editor');
        this.connected = false;
        this.socket = null;
        this.endpoint = null;
        
        // Clear message buffer
        this.messageBuffer = Buffer.alloc(0);
        
        // Clear pending commands
        const closeError = createConnectionClosedError();
        for (const [id, pending] of this.pendingCommands) {
          pending.reject(closeError);
        }
        this.pendingCommands.clear();
        this.rejectQueuedCommands(closeError);
        
        // Emit disconnected event
        this.emit('disconnected');
        
        // Attempt reconnection only if not intentionally disconnecting
        if (!this.isDisconnecting && this.shouldAutoReconnect()) {
          this.scheduleReconnect();
        }
      });

      // Attempt connection
      this.socket.connect(endpoint.port, endpoint.host);
      
      // Set timeout for initial connection
      connectionTimeout = setTimeout(() => {
        if (!this.connected && !resolved && this.socket) {
          // Remove event listeners before destroying to prevent callbacks after timeout
          this.socket.removeAllListeners();
          this.socket.destroy();
          this.socket = null;
          // Drop the cached endpoint so the re-armed reconnect re-discovers the
          // live listener (the port may have changed after a Unity reload) instead
          // of latching onto this stale one.
          this.endpoint = null;
          rejectConnect(new Error('Connection timeout'));
          // removeAllListeners() above strips the 'close' handler that normally
          // re-arms reconnection. A connect that *hangs* (Unity mid-domain-reload
          // or slow play-mode boot) would otherwise silently kill the reconnect
          // chain, leaving the bridge stuck until manually restarted. Re-arm it.
          if (!this.isDisconnecting && this.shouldAutoReconnect()) {
            this.scheduleReconnect();
          }
        }
      }, this.config.unity.commandTimeout);
    });
  }

  emitConnectionError(error) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  shouldAutoReconnect() {
    return this.config.unity.autoReconnect !== false &&
      process.env.DISABLE_AUTO_RECONNECT !== 'true';
  }

  async resolveEndpoint({ validate, ignoreCached = false } = {}) {
    const endpoint = await resolveUnityEndpoint({
      unityConfig: this.config.unity,
      lastEndpoint: ignoreCached ? null : this.endpoint,
      cwd: this.config.unity.discovery?.cwd || process.cwd()
    });
    validate?.();
    this.endpoint = endpoint;
    return endpoint;
  }

  /**
   * Disconnects from Unity Editor
   */
  disconnect() {
    this.connectionGeneration++;
    this.isDisconnecting = true;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const error = createConnectionClosedError('Connection closed by disconnect');

    if (this.activeConnectReject) {
      this.activeConnectReject(error);
      this.activeConnectReject = null;
    }

    for (const [, pending] of this.pendingCommands) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
    this.rejectQueuedCommands(error);
    
    if (this.socket) {
      try {
        // Remove all listeners before destroying to prevent async callbacks
        this.socket.removeAllListeners();
        this.socket.destroy();
      } catch (error) {
        // Ignore errors during cleanup
      }
      this.socket = null;
    }
    
    this.connected = false;
    this.isDisconnecting = false;
  }

  rejectQueuedCommands(error) {
    if (this.commandQueue.length === 0) {
      return;
    }

    const queued = this.commandQueue.splice(0);
    for (const command of queued) {
      command.cleanup();
      command.reject(withExecutionState(error, 'not_started'));
    }
  }

  /**
   * Schedules a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.config.unity.reconnectDelay * Math.pow(this.config.unity.reconnectBackoffMultiplier, this.reconnectAttempts),
      this.config.unity.maxReconnectDelay
    );

    logger.info(`Scheduling reconnection in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    const generation = this.connectionGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect().catch((error) => {
        logger.error('Reconnection failed:', error.message);
        if (generation === this.connectionGeneration && this.shouldAutoReconnect()) {
          this.scheduleReconnect();
        }
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Handles incoming data from Unity
   * @param {Buffer} data
   */
  handleData(data) {
    // Check if this is an unframed Unity debug log
    if (data.length > 0 && !this.messageBuffer.length) {
      const dataStr = data.toString('utf8');
      if (dataStr.startsWith('[Unity Editor MCP]') || dataStr.startsWith('[Unity]')) {
        logger.debug(`[Unity] Received unframed debug log: ${dataStr.trim()}`);
        // Don't process unframed logs as messages
        return;
      }
    }
    
    // Append new data to buffer
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);
    
    // Process complete messages
    while (this.messageBuffer.length >= 4) {
      // Read message length (first 4 bytes, big-endian)
      const messageLength = this.messageBuffer.readInt32BE(0);
      
      // Validate message length
      if (messageLength < 0 || messageLength > 1024 * 1024) { // Max 1MB messages
        logger.error(`[Unity] Invalid message length: ${messageLength}`);
        
        // Try to recover by looking for valid framed message
        // Look for a reasonable length value (positive, less than 10KB for typical responses)
        let recoveryIndex = -1;
        for (let i = 4; i < Math.min(this.messageBuffer.length - 4, 100); i++) {
          const testLength = this.messageBuffer.readInt32BE(i);
          if (testLength > 0 && testLength < 10240) {
            // Check if this could be a valid JSON message
            if (i + 4 + testLength <= this.messageBuffer.length) {
              const testData = this.messageBuffer.slice(i + 4, i + 4 + testLength).toString('utf8');
              if (testData.trim().startsWith('{')) {
                recoveryIndex = i;
                break;
              }
            }
          }
        }
        
        if (recoveryIndex > 0) {
          logger.warn(`[Unity] Discarding ${recoveryIndex} bytes of invalid data`);
          this.messageBuffer = this.messageBuffer.slice(recoveryIndex);
          continue;
        } else {
          // Can't recover, clear buffer
          logger.error('[Unity] Unable to recover from invalid frame, clearing buffer');
          this.messageBuffer = Buffer.alloc(0);
          break;
        }
      }
      
      // Check if we have the complete message
      if (this.messageBuffer.length >= 4 + messageLength) {
        // Extract message
        const messageData = this.messageBuffer.slice(4, 4 + messageLength);
        this.messageBuffer = this.messageBuffer.slice(4 + messageLength);
        
        // Process the message
        try {
          const message = messageData.toString('utf8');
          
          // Skip non-JSON messages (like debug logs)
          if (!message.trim().startsWith('{')) {
            logger.warn(`[Unity] Skipping non-JSON message: ${message.substring(0, 50)}...`);
            continue;
          }
          
          logger.info(`[Unity] Received framed message: ${message}`);
          
          const response = JSON.parse(message);
          logger.info(`[Unity] Parsed response:`, response);
          
          // Check if this is a response to a pending command
          if (response.id && this.pendingCommands.has(response.id)) {
            logger.info(`[Unity] Found pending command for ID ${response.id}`);
            const pending = this.pendingCommands.get(response.id);
            this.pendingCommands.delete(response.id);
            
            // Handle both old and new response formats
            if (response.status === 'success' || response.success === true) {
              logger.info(`[Unity] Command ${response.id} succeeded`);
              
              let result;
              if (Object.prototype.hasOwnProperty.call(response, 'result')) {
                result = response.result;
              } else if (Object.prototype.hasOwnProperty.call(response, 'data')) {
                result = response.data;
              } else {
                result = {};
              }
              
              // If result is a string, try to parse it as JSON
              if (typeof result === 'string') {
                try {
                  result = JSON.parse(result);
                  logger.info(`[Unity] Parsed string result as JSON:`, result);
                } catch (parseError) {
                  logger.warn(`[Unity] Failed to parse result as JSON: ${parseError.message}`);
                  // Keep the original string value
                }
              }
              
              logger.info(`[Unity] Command ${response.id} resolved successfully`);
              pending.resolve(result);
            } else if (response.status === 'error' || response.success === false) {
              logger.error(`[Unity] Command ${response.id} failed:`, response.error);
              const error = new Error(response.error || 'Command failed');
              error.code = response.code || response.errorCode || 'UNITY_ERROR';
              error.details = { ...response.details };
              // Only the editor's explicit rejection can confirm an already-sent command did not start.
              if (error.code === 'AUTH_FAILED') {
                error.details.executionState = 'not_started';
              }
              pending.reject(error);
            } else {
              // Unknown format
              logger.warn(`[Unity] Command ${response.id} has unknown response format`);
              pending.resolve(response);
            }
          } else {
            // Handle unsolicited messages
            logger.info(`[Unity] Received unsolicited message:`, response);
            this.emit('message', response);
          }
        } catch (error) {
          logger.error('[Unity] Failed to parse response:', error.message);
          logger.debug(`[Unity] Raw message: ${messageData.toString().substring(0, 200)}...`);
          
          // Check if this looks like a Unity log message
          const messageStr = messageData.toString();
          if (messageStr.includes('[Unity Editor MCP]')) {
            logger.debug('[Unity] Received Unity log message instead of JSON response');
            // Don't treat this as a critical error
          }
        }
      } else {
        // Not enough data yet, wait for more
        break;
      }
    }
  }

  /**
   * Sends a command to Unity
   * @param {string} type - Command type
   * @param {object} params - Command parameters
   * @returns {Promise<any>} - Response from Unity
   */
  async sendCommand(type, params = {}, options = {}) {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, this.config.unity.commandTimeout);
    const deadlineUnixMs = Math.min(options.deadlineUnixMs ?? Infinity, Date.now() + timeoutMs);
    const context = commandContext.getStore();
    const request = { ...options, timeoutMs, deadlineUnixMs, context, signal: options.signal ?? context?.signal };
    throwIfCommandExpired(type, request);

    if (this.isDisconnecting) {
      throw withExecutionState(createConnectionClosedError('Connection is disconnecting'), 'not_started');
    }
    if (!this.commandInFlight) {
      return this.runQueuedCommand(type, params, request);
    }

    return new Promise((resolve, reject) => {
      const removeQueued = (error) => {
        const index = this.commandQueue.indexOf(command);
        if (index >= 0) {
          this.commandQueue.splice(index, 1);
          command.cleanup();
          reject(error);
        }
      };
      const onAbort = () => removeQueued(createCommandCancelledError(type));
      const timeout = setTimeout(() => removeQueued(createCommandTimeoutError(type, null, timeoutMs)), deadlineUnixMs - Date.now());
      const command = {
        type,
        params,
        options: request,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          request.signal?.removeEventListener('abort', onAbort);
        }
      };
      this.commandQueue.push(command);
      request.signal?.addEventListener('abort', onAbort, { once: true });

      // A long-running command may be blocking the queue. Check new requests independently.
      this.assertNotBusy().catch(removeQueued);
    });
  }

  async getUnityStatus() {
    return getUnityStatus(this.config.unity, this.endpoint);
  }

  async assertNotBusy() {
    let status;
    try {
      status = await this.getUnityStatus();
    } catch (error) {
      logger.warn(`[Unity] Could not read editor activity: ${error.message}`);
      return;
    }
    const busyError = createUnityBusyError(status);
    if (busyError) {
      throw busyError;
    }
  }

  async runQueuedCommand(type, params, options) {
    this.commandInFlight = true;
    try {
      return await this.sendCommandWithAuthRecovery(type, params, options);
    } finally {
      this.commandInFlight = false;
      this.runNextQueuedCommand();
    }
  }

  runNextQueuedCommand() {
    if (this.commandInFlight || this.commandQueue.length === 0) {
      return;
    }

    const next = this.commandQueue.shift();
    next.cleanup();
    this.runQueuedCommand(next.type, next.params, next.options).then(next.resolve, next.reject);
  }

  async sendCommandWithAuthRecovery(type, params, options) {
    const maxAttempts = Math.max(1, Math.floor(options.authRetryAttempts || this.config.unity.authRetryAttempts || 2));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.sendCommandNow(type, params, options);
      } catch (error) {
        if (!isAuthFailureError(error) || attempt >= maxAttempts) {
          throw error;
        }

        // AUTH_FAILED is a definitive rejection before execution. Only this rejection is retried.
        await beforeWriting(type, options, () => this.recoverFromAuthFailure(() => throwIfCommandExpired(type, options)));
      }
    }
  }

  async sendCommandNow(type, params, options) {
    await beforeWriting(type, options, async () => {
      await this.assertNotBusy();
      const validate = () => throwIfCommandExpired(type, options);
      validate();
      if (!this.connected) {
        const error = new Error('Not connected to Unity');
        error.code = 'NOT_CONNECTED';
        throw error;
      }

      // Domain reload can rotate the token while keeping the same PID and port.
      await this.refreshAuthTokenFromRegistry(validate);
      validate();
      await this.ensureAuthenticatedEndpoint(validate);
    });
    throwIfCommandExpired(type, options);

    const socket = this.socket;
    if (!this.connected || !socket || socket.destroyed || socket.writable === false) {
      throw withExecutionState(createConnectionClosedError(), 'not_started');
    }

    const id = String(++this.commandId);
    const { timeoutMs, deadlineUnixMs, signal, context } = options;
    const authToken = this.endpoint?.authToken;
    const command = { id, type, params, deadlineUnixMs, ...(authToken && { authToken }) };
    const framedMessage = frameMessage(command);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pendingCommands.delete(id);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const rejectPending = (error) => {
        cleanup();
        const failure = error.details?.executionState ? error : withExecutionState(error, 'unknown');
        if (failure.details.executionState === 'unknown') {
          failure.details.guidance = '请先核对 Unity 中的实际结果，再决定是否重试。';
        }
        if (context && failure.details.executionState !== 'not_started') {
          context.mayHaveStarted = true;
        }
        reject(failure);
      };
      const onAbort = () => {
        this.cancelSentCommand(socket, id, authToken);
        rejectPending(createCommandCancelledError(type, id));
      };

      const timeout = setTimeout(() => {
        const error = createCommandTimeoutError(type, id, timeoutMs);
        this.cancelSentCommand(socket, id, authToken);
        rejectPending(error);
        this.closeTimedOutConnection();
      }, Math.max(1, deadlineUnixMs - Date.now()));

      this.pendingCommands.set(id, {
        resolve: (data) => {
          cleanup();
          const authError = createAuthFailureError(data);
          if (authError) {
            reject(authError);
            return;
          }
          if (context) {
            context.mayHaveStarted = true;
          }
          resolve(data);
        },
        reject: rejectPending
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      logger.info(`[Unity] Sending framed command ${id}: ${JSON.stringify(redactCommand(command))}`);
      // From the first write attempt onward, transport failures cannot establish whether Unity ran the command.
      try {
        socket.write(framedMessage, (error) => {
          if (error && this.pendingCommands.has(id)) {
            rejectPending(error);
          }
        });
      } catch (error) {
        rejectPending(error);
      }
    });
  }

  cancelSentCommand(socket, id, authToken) {
    if (!authToken || socket.destroyed || socket.writable === false) {
      return;
    }

    try {
      socket.write(frameMessage({ type: 'cancel_command', params: { commandId: id }, authToken }), () => {});
    } catch {
      // The command's editor-side deadline still applies if cancellation cannot be delivered.
    }
  }

  async recoverFromAuthFailure(validate) {
    const previousEndpoint = this.endpoint
      ? {
          host: this.endpoint.host,
          port: this.endpoint.port,
          authToken: this.endpoint.authToken
        }
      : null;
    const attempts = Math.max(1, Math.floor(this.config.unity.authRefreshRetryAttempts || 5));
    const delayMs = Math.max(0, Math.floor(this.config.unity.authRefreshRetryDelayMs || 100));

    for (var attempt = 0; attempt < attempts; attempt++)
    {
      await this.refreshAuthTokenFromRegistry(validate);
      validate();
      if (this.endpoint?.authToken && this.endpoint.authToken !== previousEndpoint?.authToken) {
        return;
      }

      if (delayMs > 0 && attempt < attempts - 1) {
        await sleep(delayMs);
        validate();
      }
    }

    const endpoint = await this.resolveEndpoint({ validate, ignoreCached: true });
    if (!previousEndpoint || !endpoint) {
      return;
    }

    if (Number(endpoint.port) !== Number(previousEndpoint.port)) {
      const socket = this.socket;
      this.connected = false;
      this.socket = null;
      this.messageBuffer = Buffer.alloc(0);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      await this.connect();
    }
  }

  async ensureAuthenticatedEndpoint(validate) {
    if (this.endpoint?.authToken || this.config.unity.discovery?.enabled === false) {
      return;
    }

    const previousEndpoint = this.endpoint
      ? {
          host: this.endpoint.host,
          port: this.endpoint.port
        }
      : null;
    const endpoint = await this.resolveEndpoint({ validate });
    if (!previousEndpoint || !endpoint) {
      return;
    }

    if (Number(endpoint.port) !== Number(previousEndpoint.port)) {
      const socket = this.socket;
      this.connected = false;
      this.socket = null;
      this.messageBuffer = Buffer.alloc(0);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      await this.connect();
    }
  }

  closeTimedOutConnection() {
    const socket = this.socket;
    this.connected = false;
    this.socket = null;
    this.endpoint = null;
    this.messageBuffer = Buffer.alloc(0);

    const closeError = createConnectionClosedError('Connection closed after command timeout');
    for (const [, pending] of this.pendingCommands) {
      pending.reject(closeError);
    }
    this.pendingCommands.clear();
    this.rejectQueuedCommands(closeError);
    this.emit('disconnected');

    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    if (this.shouldAutoReconnect()) {
      this.scheduleReconnect();
    }
  }

  /**
   * Refreshes the cached per-session auth token from the Unity instance registry. Unity regenerates the
   * token on each domain reload while keeping the same pid/port, so the cached token must be re-read or
   * commands fail with AUTH_FAILED until the bridge is restarted.
   */
  async refreshAuthTokenFromRegistry(validate) {
    try {
      const endpoint = this.endpoint;
      if (!endpoint?.port || !endpoint?.instance?.pid) return;
      const instances = await readUnityInstances({
        registryDir: this.config.unity.discovery?.registryDir,
        includeStale: true
      });
      const fresh = instances.find(
        (instance) => instance.alive && instance.isBatchMode !== true && instance.isAssetImportWorker !== true &&
          Number(instance.port) === Number(endpoint.port) &&
          instance.pid === endpoint.instance.pid &&
          (!endpoint.instance.processStartedAt || endpoint.instance.processStartedAt === instance.processStartedAt)
      );
      if (this.endpoint === endpoint && fresh?.authToken && fresh.authToken !== endpoint.authToken) {
        validate?.();
        logger.info('[Unity] auth token rotated (domain reload) — refreshed from registry');
        this.endpoint.authToken = fresh.authToken;
        this.endpoint.instance = fresh;
      }
    } catch (err) {
      logger.warn?.(`[Unity] auth token refresh failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Sends a ping command to Unity
   * @returns {Promise<any>}
   */
  async ping() {
    // Use normal command sending for ping with proper framing
    return this.sendCommand('ping', {});
  }

  /**
   * Checks if connected to Unity
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  getConnectionInfo() {
    return {
      connected: this.connected,
      endpoint: redactEndpoint(this.endpoint)
    };
  }
}

function redactCommand(command) {
  return {
    ...command,
    ...(command.authToken && { authToken: '[redacted]' })
  };
}

function createConnectionClosedError(message = 'Connection closed') {
  const error = new Error(message);
  error.code = 'CONNECTION_CLOSED';
  return error;
}

function createCommandTimeoutError(type, id, timeoutMs) {
  const error = new Error('Command timeout');
  error.code = 'COMMAND_TIMEOUT';
  error.details = {
    command: type,
    commandId: id,
    timeoutMs,
    executionState: id ? 'unknown' : 'not_started'
  };
  return error;
}

function createAuthFailureError(payload) {
  if (!isAuthFailurePayload(payload)) {
    return null;
  }

  const error = new Error(payload?.message || payload?.error || 'Invalid or missing Unity Editor MCP auth token');
  error.code = 'AUTH_FAILED';
  error.details = { ...payload?.details, executionState: 'not_started' };
  return error;
}

function isAuthFailureError(error) {
  return error?.code === 'AUTH_FAILED' && error.details?.executionState === 'not_started';
}

function isAuthFailurePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return (payload.code || payload.errorCode) === 'AUTH_FAILED';
}

function createCommandCancelledError(type, id = null) {
  const error = new Error('Request cancelled');
  error.code = 'REQUEST_CANCELLED';
  error.details = { command: type, commandId: id, executionState: id ? 'unknown' : 'not_started' };
  return error;
}

function withExecutionState(error, executionState) {
  const result = new Error(error.message, { cause: error });
  result.code = error.code;
  result.details = { ...error.details, executionState };
  return result;
}

function throwIfCommandExpired(type, options) {
  if (options.signal?.aborted) {
    throw createCommandCancelledError(type);
  }
  if (Date.now() >= options.deadlineUnixMs) {
    throw createCommandTimeoutError(type, null, options.timeoutMs);
  }
}

async function beforeWriting(type, options, operation) {
  throwIfCommandExpired(type, options);
  const { signal, deadlineUnixMs, timeoutMs } = options;
  let timeout;
  let onAbort;
  try {
    const invalidated = new Promise((_, reject) => {
      onAbort = () => reject(createCommandCancelledError(type));
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => reject(createCommandTimeoutError(type, null, timeoutMs)), deadlineUnixMs - Date.now());
    });
    await Promise.race([operation(), invalidated]);
  } catch (error) {
    throw error.details?.executionState ? error : withExecutionState(error, 'not_started');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function frameMessage(command) {
  const message = Buffer.from(JSON.stringify(command), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeInt32BE(message.length);
  return Buffer.concat([length, message]);
}

function normalizeTimeoutMs(value, fallback) {
  if (Number.isFinite(value) && value > 0) {
    return Math.max(1, Math.floor(value));
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') {
    return endpoint;
  }

  return {
    ...endpoint,
    ...(endpoint.authToken && { authToken: '[redacted]' }),
    ...(endpoint.instance && {
      instance: {
        ...endpoint.instance,
        ...(endpoint.instance.authToken && { authToken: '[redacted]' })
      }
    })
  };
}
