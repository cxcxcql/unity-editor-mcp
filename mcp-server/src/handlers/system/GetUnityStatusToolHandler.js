import { BaseToolHandler } from '../base/BaseToolHandler.js';

export class GetUnityStatusToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'get_unity_status',
      'Read the local Unity editor activity snapshot without waiting for its main thread. Check this after UNITY_BUSY.',
      { type: 'object', properties: {}, additionalProperties: false }
    );
    this.unityConnection = unityConnection;
  }

  async execute() {
    return this.unityConnection.getUnityStatus();
  }
}
