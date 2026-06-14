import net from 'net';
import { EventEmitter } from 'events';
import { config, logger } from './config.js';
import { resolveUnityEndpoint } from './unityDiscovery.js';

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

    const endpoint = await this.resolveEndpoint();

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

          if (!this.isDisconnecting && process.env.DISABLE_AUTO_RECONNECT !== 'true') {
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
        const wasSocket = this.socket;
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
        if (!this.isDisconnecting && process.env.DISABLE_AUTO_RECONNECT !== 'true') {
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
          if (!this.isDisconnecting && process.env.DISABLE_AUTO_RECONNECT !== 'true') {
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

  async resolveEndpoint() {
    this.endpoint = await resolveUnityEndpoint({
      unityConfig: this.config.unity,
      lastEndpoint: this.endpoint,
      cwd: this.config.unity.discovery?.cwd || process.cwd()
    });
    return this.endpoint;
  }

  /**
   * Disconnects from Unity Editor
   */
  disconnect() {
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
      command.reject(error);
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

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect().catch((error) => {
        logger.error('Reconnection failed:', error.message);
      });
    }, delay);
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
              if (response.details !== undefined) {
                error.details = response.details;
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
  async sendCommand(type, params = {}) {
    logger.info(`[Unity] sendCommand called: ${type}`, { connected: this.connected, params });

    if (this.isDisconnecting) {
      throw createConnectionClosedError('Connection is disconnecting');
    }

    if (!this.commandInFlight) {
      return this.runQueuedCommand(type, params);
    }

    return new Promise((resolve, reject) => {
      this.commandQueue.push({ type, params, resolve, reject });
    });
  }

  async runQueuedCommand(type, params) {
    this.commandInFlight = true;
    try {
      return await this.sendCommandNow(type, params);
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
    this.runQueuedCommand(next.type, next.params).then(next.resolve, next.reject);
  }

  async sendCommandNow(type, params = {}) {
    if (!this.connected) {
      logger.error('[Unity] Cannot send command - not connected');
      throw new Error('Not connected to Unity');
    }

    const id = String(++this.commandId);
    const command = {
      id,
      type,
      params,
      ...(this.endpoint?.authToken && { authToken: this.endpoint.authToken })
    };

    return new Promise((resolve, reject) => {
      logger.info(`[Unity] Setting up command ${id} with timeout ${this.config.unity.commandTimeout}ms`);
      
      // Set up timeout
      const timeout = setTimeout(() => {
        logger.error(`[Unity] Command ${id} timed out after ${this.config.unity.commandTimeout}ms`);
        this.pendingCommands.delete(id);
        reject(new Error('Command timeout'));
      }, this.config.unity.commandTimeout);

      // Store pending command
      this.pendingCommands.set(id, {
        resolve: (data) => {
          logger.info(`[Unity] Command ${id} resolved successfully`);
          clearTimeout(timeout);
          resolve(data);
        },
        reject: (error) => {
          logger.error(`[Unity] Command ${id} rejected with error:`, error.message);
          clearTimeout(timeout);
          reject(error);
        }
      });

      // Send command with framing
      const json = JSON.stringify(command);
      const messageBuffer = Buffer.from(json, 'utf8');
      const lengthBuffer = Buffer.allocUnsafe(4);
      lengthBuffer.writeInt32BE(messageBuffer.length, 0);
      
      const framedMessage = Buffer.concat([lengthBuffer, messageBuffer]);
      
      logger.info(`[Unity] Sending framed command ${id}: ${JSON.stringify(redactCommand(command))}`);
      
      this.socket.write(framedMessage, (error) => {
        if (error) {
          logger.error(`[Unity] Failed to write command ${id}:`, error.message);
          this.pendingCommands.delete(id);
          clearTimeout(timeout);
          reject(error);
        } else {
          logger.info(`[Unity] Command ${id} written successfully, waiting for response...`);
        }
      });
    });
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
