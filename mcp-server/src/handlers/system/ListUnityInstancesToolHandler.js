import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { config } from '../../core/config.js';
import { createDiscoveryReport } from '../../core/unityDiscovery.js';

/**
 * Handler for listing Unity Editor MCP instances discovered on this machine.
 */
export class ListUnityInstancesToolHandler extends BaseToolHandler {
  constructor(unityConnection) {
    super(
      'list_unity_instances',
      'List live Unity Editor MCP instances and show which one would be selected',
      {
        type: 'object',
        properties: {
          projectPath: {
            type: 'string',
            description: 'Optional Unity project path to use when selecting an instance'
          }
        },
        required: []
      }
    );

    this.unityConnection = unityConnection;
  }

  async execute(params) {
    const unityConfig = {
      ...config.unity,
      discovery: {
        ...config.unity.discovery,
        projectPath: params.projectPath || config.unity.discovery.projectPath
      }
    };

    const report = await createDiscoveryReport({
      unityConfig,
      cwd: process.cwd()
    });

    return {
      registryDir: report.registryDir,
      targetProjectPath: report.targetProjectPath,
      selectedEndpoint: report.endpoint,
      selectionError: report.error,
      instances: report.instances.map((instance) => ({
        projectPath: instance.projectPath,
        projectName: instance.projectName,
        pid: instance.pid,
        host: instance.host,
        port: instance.port,
        unityVersion: instance.unityVersion,
        packageVersion: instance.packageVersion,
        status: instance.status,
        activeScene: instance.activeScene,
        lastSeen: instance.lastSeen,
        alive: instance.alive,
        stale: instance.stale
      }))
    };
  }
}
