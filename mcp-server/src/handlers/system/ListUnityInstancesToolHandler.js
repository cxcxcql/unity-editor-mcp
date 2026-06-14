import { BaseToolHandler } from '../base/BaseToolHandler.js';
import { config } from '../../core/config.js';
import { createDiscoveryReport, redactDiscoveryReport } from '../../core/unityDiscovery.js';
import { getServerMetadata } from '../../core/serverMetadata.js';

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
            default: true
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

    if (params.compact !== false) {
      return createCompactReport(report, params.includeStale === true);
    }

    return {
      server: getServerMetadata(),
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
        isBatchMode: instance.isBatchMode,
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
    .filter((instance) => includeStale || (instance.alive && !instance.stale && instance.isBatchMode !== true))
    .filter((instance) => !selectedProjectPath || instance.projectPath === selectedProjectPath)
    .map((instance) => summarizeInstance(instance, selected?.instanceId));

  return {
    compact: true,
    server: getServerMetadata(),
    registryDir: report.registryDir,
    targetProjectPath: report.targetProjectPath,
    targetWorkspaceId: report.targetWorkspaceId,
    selectedEndpoint: selected,
    selectionError: report.error,
    selectionErrorCode: report.errorCode,
    instances,
    conflicts: instances.filter((instance) => instance.recommended !== true),
    staleCounts: countStaleInstances(report.instances),
    hiddenCounts: countHiddenInstances(report.instances)
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
    isBatchMode: instance.isBatchMode,
    alive: instance.alive,
    stale: instance.stale,
    recommended: instance.instanceId === selectedInstanceId
  };
}

function countStaleInstances(instances) {
  const byProject = {};
  let total = 0;

  for (const instance of instances) {
    if (!instance.stale && instance.alive) {
      continue;
    }

    total++;
    const key = instance.projectName || instance.projectPath || '(unknown project)';
    byProject[key] = (byProject[key] || 0) + 1;
  }

  return { total, byProject };
}

function countHiddenInstances(instances) {
  const byProject = {};
  let batchMode = 0;
  let staleOrDead = 0;

  for (const instance of instances) {
    if (instance.isBatchMode === true) {
      batchMode++;
      const key = instance.projectName || instance.projectPath || '(unknown project)';
      byProject[key] = (byProject[key] || 0) + 1;
    }

    if (instance.stale || !instance.alive) {
      staleOrDead++;
    }
  }

  return { batchMode, staleOrDead, byProject };
}
