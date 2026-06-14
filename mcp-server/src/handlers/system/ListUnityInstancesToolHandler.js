import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { config } from '../../core/config.js';
import { createDiscoveryReport, redactDiscoveryReport } from '../../core/unityDiscovery.js';

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
          },
          allowSingleInstanceFallback: {
            type: 'boolean',
            description: 'Allow selecting the only live Unity instance even when it does not match the current workspace'
          },
          compact: {
            type: 'boolean',
            description: 'Return a compact report with the selected endpoint and relevant live conflicts only',
            default: false
          },
          includeStale: {
            type: 'boolean',
            description: 'Include stale or dead registry entries in compact output',
            default: false
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
        workspaceId: params.workspaceId || config.unity.discovery.workspaceId,
        allowSingleInstanceFallback: params.allowSingleInstanceFallback ?? config.unity.discovery.allowSingleInstanceFallback
      }
    };

    const report = redactDiscoveryReport(await createDiscoveryReport({
      unityConfig,
      cwd: process.cwd()
    }));

    if (params.compact === true) {
      return createCompactReport(report, params.includeStale === true);
    }

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

function createCompactReport(report, includeStale) {
  const selected = summarizeEndpoint(report.endpoint);
  const selectedProjectPath = selected?.projectPath || report.targetProjectPath;
  const instances = report.instances
    .filter((instance) => includeStale || (instance.alive && !instance.stale))
    .filter((instance) => !selectedProjectPath || instance.projectPath === selectedProjectPath)
    .map((instance) => summarizeInstance(instance, selected?.instanceId));

  return {
    compact: true,
    registryDir: report.registryDir,
    targetProjectPath: report.targetProjectPath,
    targetWorkspaceId: report.targetWorkspaceId,
    selectedEndpoint: selected,
    selectionError: report.error,
    selectionErrorCode: report.errorCode,
    instances,
    conflicts: instances.filter((instance) => instance.recommended !== true)
  };
}

function summarizeEndpoint(endpoint) {
  if (!endpoint) {
    return null;
  }

  return {
    host: endpoint.host,
    port: endpoint.port,
    source: endpoint.source,
    reason: endpoint.reason,
    projectPath: endpoint.projectPath || endpoint.instance?.projectPath,
    instanceId: endpoint.instance?.instanceId,
    workspaceId: endpoint.instance?.workspaceId,
    packageVersion: endpoint.instance?.packageVersion,
    recommended: true
  };
}

function summarizeInstance(instance, selectedInstanceId) {
  return {
    instanceId: instance.instanceId,
    projectPath: instance.projectPath,
    projectName: instance.projectName,
    workspaceId: instance.workspaceId,
    pid: instance.pid,
    host: instance.host,
    port: instance.port,
    unityVersion: instance.unityVersion,
    packageVersion: instance.packageVersion,
    activeScene: instance.activeScene,
    alive: instance.alive,
    stale: instance.stale,
    recommended: instance.instanceId === selectedInstanceId
  };
}
