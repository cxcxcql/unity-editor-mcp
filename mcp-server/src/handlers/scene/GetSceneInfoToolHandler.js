import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { getSceneInfoToolDefinition } from '../../tools/scene/getSceneInfo.js';

const inputSchema = {
    ...getSceneInfoToolDefinition.inputSchema,
    oneOf: [
        {
            not: {
                anyOf: [
                    { required: ['scenePath'] },
                    { required: ['sceneName'] }
                ]
            }
        },
        {
            required: ['scenePath'],
            not: { required: ['sceneName'] }
        },
        {
            required: ['sceneName'],
            not: { required: ['scenePath'] }
        }
    ]
};

/**
 * Handler for get_scene_info tool
 */
export class GetSceneInfoToolHandler extends BaseToolHandler {
    constructor(unityConnection) {
        super(
            getSceneInfoToolDefinition.name,
            getSceneInfoToolDefinition.description,
            inputSchema
        );
        this.unityConnection = unityConnection;
    }

    async execute(args) {
        if (!this.unityConnection.isConnected()) {
            throw new Error('Unity connection not available');
        }

        const result = await this.unityConnection.sendCommand('get_scene_info', args);
        if (result?.error) {
            const error = new Error(result.error);
            error.code = 'UNITY_ERROR';
            throw error;
        }

        return result;
    }
}
