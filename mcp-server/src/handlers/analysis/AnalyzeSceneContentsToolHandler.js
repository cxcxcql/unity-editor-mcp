import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { analyzeSceneContentsToolDefinition } from '../../tools/analysis/analyzeSceneContents.js';

/**
 * Handler for analyze_scene_contents tool
 */
export class AnalyzeSceneContentsToolHandler extends BaseToolHandler {
    constructor(unityConnection) {
        super(
            analyzeSceneContentsToolDefinition.name,
            analyzeSceneContentsToolDefinition.description,
            analyzeSceneContentsToolDefinition.inputSchema
        );
        this.unityConnection = unityConnection;
    }

    async execute(args) {
        if (!this.unityConnection.isConnected()) {
            throw new Error('Unity connection not available');
        }

        const result = await this.unityConnection.sendCommand('analyze_scene_contents', args);

        if (!result || typeof result === 'string') {
            throw new Error('Invalid response format');
        }

        if (result.error) {
            const error = new Error(result.error);
            error.code = 'UNITY_ERROR';
            throw error;
        }

        return result;
    }
}
