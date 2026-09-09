/**
 * Tool definition for save_scene
 */
export const saveSceneToolDefinition = {
    name: 'save_scene',
    description: 'Save the current scene in Unity',
    inputSchema: {
        type: 'object',
        properties: {
            scenePath: {
                type: 'string',
                description: 'Path where to save the scene. If not provided, saves to current scene path. Required if saveAs is true.'
            },
            saveAs: {
                type: ['boolean', 'string'],
                description: 'Whether to save as a new scene (creates a copy). Default: false. A string value is accepted as a shortcut and used directly as the save destination.'
            }
        },
        required: []
    }
};

/**
 * Handler for save_scene tool
 */
export async function saveSceneHandler(unityConnection, args) {
    try {
        // Check connection
        if (!unityConnection.isConnected()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Failed to save scene: Unity connection not available'
                    }
                ],
                isError: true
            };
        }

        // Validate saveAs requires scenePath (a string saveAs already carries its own destination)
        if (args.saveAs && !args.scenePath && typeof args.saveAs !== 'string') {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Failed to save scene: scenePath is required when saveAs is true'
                    }
                ],
                isError: true
            };
        }

        // Send command to Unity
        const result = await unityConnection.sendCommand('save_scene', args);

        // Handle Unity response
        if (result.status === 'error') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to save scene: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        // Success response
        return {
            content: [
                {
                    type: 'text',
                    text: result.result.summary || `Scene saved successfully`
                }
            ],
            isError: false
        };
    } catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Failed to save scene: ${error.message}`
                }
            ],
            isError: true
        };
    }
}