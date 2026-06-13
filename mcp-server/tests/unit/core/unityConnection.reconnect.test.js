import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { EventEmitter } from 'events';
import { UnityConnection } from '../../../src/core/unityConnection.js';

// Regression tests for the bridge-drop bug: a connect attempt that *times out*
// (Unity mid-domain-reload / slow play-mode boot) must not silently kill the
// reconnect chain, and a command sent while disconnected must re-dial.
describe('UnityConnection reconnect resilience', () => {
  let connection;
  let mockSocket;
  let originalSocket;
  let testConfig;

  beforeEach(() => {
    testConfig = {
      unity: {
        host: 'localhost',
        port: 6400,
        hasExplicitPort: true,
        reconnectDelay: 10,
        maxReconnectDelay: 100,
        reconnectBackoffMultiplier: 2,
        commandTimeout: 30,
        discovery: { enabled: false }
      }
    };
    connection = new UnityConnection({ config: testConfig });

    mockSocket = new EventEmitter();
    mockSocket.write = mock.fn((data, cb) => { if (cb) cb(); });
    mockSocket.destroy = mock.fn(() => {
      setImmediate(() => {
        if (!mockSocket.destroyed) {
          mockSocket.destroyed = true;
          mockSocket.emit('close');
        }
      });
    });
    // Never auto-fire 'connect' -> connect() hangs until the timeout fires.
    mockSocket.connect = mock.fn(() => {});

    originalSocket = net.Socket;
    net.Socket = function () { return mockSocket; };
  });

  afterEach(() => {
    connection.isDisconnecting = true;
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    if (connection.socket) {
      connection.socket.removeAllListeners?.();
      connection.socket = null;
    }
    connection.connected = false;
    if (mockSocket) {
      mockSocket.removeAllListeners();
      mockSocket.destroyed = true;
    }
    net.Socket = originalSocket;
  });

  it('schedules a reconnect when a connect attempt times out', async () => {
    const reconnectSpy = mock.method(connection, 'scheduleReconnect', () => {});

    await assert.rejects(connection.connect(), /timeout/i);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      reconnectSpy.mock.callCount() >= 1,
      'a connect timeout must re-arm the reconnect chain (close handler is stripped, so it must reconnect explicitly)'
    );
  });

  it('clears the cached endpoint after a failed connect so the next attempt re-discovers', async () => {
    // Prevent the re-armed reconnect from looping during the assertion.
    mock.method(connection, 'scheduleReconnect', () => {});

    await assert.rejects(connection.connect(), /timeout/i);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      connection.endpoint,
      null,
      'a failed connect must drop the cached endpoint so reconnection re-discovers the live listener (new port after a reload) instead of latching onto the stale one'
    );
  });
});
