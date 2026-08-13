import { BaseToolHandler } from '../base/BaseToolHandler.js';

/**
 * Handler for Ares asset search (ares.assets.search)
 * Read-only: searches assets by name keyword, type, tag, or folder.
 */
export class AssetSearchToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'ares_assets_search',
      'Search Unity assets by name keyword, type, tag, or folder. Returns GUID, path, type, and match score.',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Name keyword to match against asset names'
          },
          type: {
            type: 'string',
            enum: ['prefab', 'script', 'material', 'texture', 'scene', 'audio', 'animation', 'font', 'shader'],
            description: 'Asset type filter'
          },
          tag: {
            type: 'string',
            description: 'Filter by GameObject tag (prefabs only)'
          },
          folder: {
            type: 'string',
            description: 'Search directory, e.g. "Assets/Prefabs"'
          },
          limit: {
            type: 'integer',
            description: 'Max results to return (default 50)'
          }
        }
      }
    );
    this.unityConnection = unityConnection;
  }

  async execute(params) {
    if (!this.unityConnection.isConnected()) {
      await this.unityConnection.connect();
    }

    const result = await this.unityConnection.sendCommand('ares.assets.search', params);
    return result;
  }

  getExamples() {
    return [
      {
        input: { query: 'player', type: 'prefab', limit: 10 },
        output: {
          search_at: '2024-01-15T10:30:00Z',
          query: 'player',
          type: 'prefab',
          result_count: 1,
          total_matches: 1,
          results: [
            {
              guid: 'abc123',
              name: 'Player',
              path: 'Assets/Prefabs/Player.prefab',
              asset_type: 'GameObject',
              score: 100,
              is_prefab: true
            }
          ]
        }
      }
    ];
  }
}
