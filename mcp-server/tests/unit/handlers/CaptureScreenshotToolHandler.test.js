import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureScreenshotToolHandler } from '../../../src/handlers/screenshot/CaptureScreenshotToolHandler.js';

describe('CaptureScreenshotToolHandler', () => {
  let unityConnection;
  let handler;

  beforeEach(() => {
    unityConnection = {
      isConnected: mock.fn(() => true),
      connect: mock.fn(async () => {}),
      sendCommand: mock.fn(async () => ({
        success: true,
        path: 'Assets/Screenshots/camera.png',
        width: 1280,
        height: 720,
        captureMode: 'camera',
        cameraName: 'Main Camera',
        fileSize: 1234,
        message: 'Camera screenshot captured successfully'
      }))
    };
    handler = new CaptureScreenshotToolHandler(unityConnection);
  });

  it('allows camera capture mode in the schema and validation', () => {
    assert.ok(handler.inputSchema.properties.captureMode.enum.includes('camera'));
    assert.doesNotThrow(() => handler.validate({ captureMode: 'camera' }));
  });

  it('returns camera diagnostics from Unity responses', async () => {
    const result = await handler.execute({
      captureMode: 'camera',
      outputPath: 'Assets/Screenshots/camera.png'
    });

    assert.deepEqual(unityConnection.sendCommand.mock.calls[0].arguments, [
      'capture_screenshot',
      {
        captureMode: 'camera',
        outputPath: 'Assets/Screenshots/camera.png'
      }
    ]);
    assert.equal(result.captureMode, 'camera');
    assert.equal(result.cameraName, 'Main Camera');
  });
});
