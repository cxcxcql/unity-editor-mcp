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
          instanceId: {
            type: 'string',
            description: 'Optional Unity Editor MCP instance ID to select exactly'
          },
          projectPath: {
            type: 'string',
            description: 'Optional Unity project path to use when selecting an instance'
          },
          workspaceId: {
            type: 'string',
            description: 'Optional Unity Editor MCP workspace ID to select exactly'
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
        instanceId: params.instanceId || config.unity.discovery.instanceId,
        projectPath: params.projectPath || config.unity.discovery.projectPath,
        workspaceId: params.workspaceId || config.unity.discovery.workspaceId
      }
    };

    const report = await createDiscoveryReport({
      unityConfig,
      cwd: process.cwd()
    });

    return {
      registryDir: report.registryDir,
      targetProjectPath: report.targetProjectPath,
      targetWorkspaceId: report.targetWorkspaceId,
      localWorkspace: report.localWorkspace,
      selectedEndpoint: report.endpoint,
      selectionError: report.error,
      selectionErrorCode: report.errorCode,
      instances: report.instances.map((instance) => ({
        schemaVersion: instance.schemaVersion,
        instanceId: instance.instanceId,
        projectPath: instance.projectPath,
        projectName: instance.projectName,
        workspaceId: instance.workspaceId,
        workspaceIdSource: instance.workspaceIdSource,
        git: instance.git,
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
