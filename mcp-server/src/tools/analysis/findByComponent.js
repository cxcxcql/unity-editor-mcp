import { assertSearchPagination, searchPageGuidance, searchPageProperties } from '../searchPagination.js';

/**
 * Tool definition for find_by_component
 */
export const findByComponentToolDefinition = {
    name: 'find_by_component',
    description: 'Find GameObjects that have a specific component type. ' +
        'Scene searches skip objects named exactly "root" and their descendants by default. ' +
        'Set skipArtNodes=false only when you need to search those art nodes. ' + searchPageGuidance,
    inputSchema: {
        type: 'object',
        properties: {
            componentType: {
                type: 'string',
                description: 'Component type to search for (e.g., "Light", "Collider", "AudioSource")'
            },
            includeInactive: {
                type: 'boolean',
                description: 'Include inactive GameObjects. Default: true'
            },
            searchScope: {
                type: 'string',
                enum: ['scene', 'prefabs', 'all'],
                description: 'Search scene objects, prefab assets, or both. Default: "scene"'
            },
            matchExactType: {
                type: 'boolean',
                description: 'Match exact type only (not derived types). Default: true'
            },
            skipArtNodes: {
                type: 'boolean',
                default: true,
                description: 'Skip scene objects named exactly "root" and their descendants. Set false only to search those art nodes.'
            },
            ...searchPageProperties
        },
        required: ['componentType']
    }
};

/**
 * Handler for find_by_component tool
 */
export async function findByComponentHandler(unityConnection, args) {
    try {
        // Check connection
        if (!unityConnection.isConnected()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Failed to find GameObjects: Unity connection not available'
                    }
                ],
                isError: true
            };
        }

        // Send command to Unity
        const response = await unityConnection.sendCommand('find_by_component', args);

        // Accept the legacy envelope and the decoded result returned by the Node connection.
        const result = response.status === 'success' ? response.result : response;
        if (result?.error || result?.status === 'error') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to find GameObjects: ${result.error}`
                    }
                ],
                isError: true
            };
        }

        assertSearchPagination(args, result);
        const paginated = typeof result?.hasMore === 'boolean';
        return {
            content: [
                {
                    type: 'text',
                    text: paginated
                        ? JSON.stringify(result)
                        : result.summary || `Found ${result.totalFound} GameObjects`
                }
            ],
            isError: false,
            ...(paginated && { structuredContent: result })
        };
    } catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Failed to find GameObjects: ${error.message}`
                }
            ],
            isError: true
        };
    }
}