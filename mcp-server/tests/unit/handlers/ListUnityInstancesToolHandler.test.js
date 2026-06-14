import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../../../src/core/config.js';
import { ListUnityInstancesToolHandler } from '../../../src/handlers/system/ListUnityInstancesToolHandler.js';

describe('ListUnityInstancesToolHandler', () => {
  let tempDir;
  let registryDir;
  let originalDiscovery;
  let handler;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-list-instances-'));
    registryDir = path.join(tempDir, 'instances');
    await fsp.mkdir(registryDir, { recursive: true });

    originalDiscovery = { ...config.unity.discovery };
    config.unity.discovery = {
      ...config.unity.discovery,
      instanceId: '',
      projectPath: '',
      workspaceId: '',
      registryDir,
      staleAfterMs: 30000,
      cwd: tempDir
    };

    handler = new ListUnityInstancesToolHandler({});
  });

  afterEach(async () => {
    config.unity.discovery = originalDiscovery;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('defines explicit instance and workspace selectors', () => {
    assert.equal(handler.inputSchema.properties.instanceId.type, 'string');
    assert.equal(handler.inputSchema.properties.projectPath.type, 'string');
    assert.equal(handler.inputSchema.properties.workspaceId.type, 'string');
    assert.equal(handler.inputSchema.properties.allowSingleInstanceFallback.type, 'boolean');
    assert.equal(handler.inputSchema.properties.compact.type, 'boolean');
    assert.equal(handler.inputSchema.properties.includeStale.type, 'boolean');
  });

  it('returns workspace and Git metadata for discovered instances in verbose mode', async () => {
    const projectPath = path.join(tempDir, 'Project');
    await writeInstance('unity.json', {
      instanceId: 'unity-main',
      projectPath,
      projectName: 'Project',
      workspaceId: 'workspace-main',
      workspaceIdSource: 'git',
      git: {
        topLevel: projectPath,
        gitDir: path.join(projectPath, '.git'),
        commonDir: path.join(projectPath, '.git'),
        worktreeName: 'main',
        branch: 'main',
        head: 'abc123'
      }
    });

    const result = await handler.execute({ workspaceId: 'workspace-main', compact: false });

    assert.equal(result.targetWorkspaceId, 'workspace-main');
    assert.equal(result.selectedEndpoint.source, 'discovery');
    assert.equal(result.selectedEndpoint.reason, 'explicit workspace ID');
    assert.equal(result.instances.length, 1);
    assert.equal(result.instances[0].instanceId, 'unity-main');
    assert.equal(result.instances[0].workspaceId, 'workspace-main');
    assert.equal(result.instances[0].workspaceIdSource, 'git');
    assert.deepEqual(result.instances[0].git, {
      topLevel: projectPath,
      gitDir: path.join(projectPath, '.git'),
      commonDir: path.join(projectPath, '.git'),
      worktreeName: 'main',
      branch: 'main',
      head: 'abc123'
    });
  });

  it('defaults to compact selected endpoint and conflicts without stale noise', async () => {
    const projectPath = path.join(tempDir, 'Project');
    await writeInstance('selected.json', {
      instanceId: 'selected',
      projectPath,
      projectName: 'Project',
      workspaceId: 'workspace-selected',
      port: 50123,
      lastSeen: new Date(Date.now() + 1000).toISOString()
    });
    await writeInstance('conflict.json', {
      instanceId: 'conflict',
      projectPath,
      projectName: 'Project',
      workspaceId: 'workspace-conflict',
      port: 50124,
      lastSeen: new Date().toISOString()
    });
    await writeInstance('stale.json', {
      instanceId: 'stale',
      projectPath: path.join(tempDir, 'OldProject'),
      projectName: 'OldProject',
      workspaceId: 'workspace-stale',
      port: 50125,
      pid: 999999999,
      packageVersion: 'unknown',
      lastSeen: new Date(Date.now() - 60000).toISOString()
    });

    const result = await handler.execute({ projectPath });

    assert.equal(result.compact, true);
    assert.equal(result.server.packageName, 'unity-editor-mcp');
    assert.match(result.server.packageVersion, /^\d+\.\d+\.\d+/);
    assert.equal(typeof result.server.gitHead, 'string');
    assert.equal(result.server.pid, process.pid);
    assert.equal(result.selectedEndpoint.instanceId, 'selected');
    assert.equal(result.selectedEndpoint.recommended, true);
    assert.equal(result.instances.length, 2);
    assert.deepEqual(result.instances.map((instance) => instance.instanceId), ['selected', 'conflict']);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].instanceId, 'conflict');
    assert.equal(result.staleCounts.total, 1);
    assert.equal(result.staleCounts.byProject.OldProject, 1);
  });

  it('preserves full verbose output when compact is false', async () => {
    const projectPath = path.join(tempDir, 'Project');
    await writeInstance('selected.json', {
      instanceId: 'selected',
      projectPath,
      projectName: 'Project',
      workspaceId: 'workspace-selected',
      port: 50123
    });

    const result = await handler.execute({ projectPath, compact: false });

    assert.equal(result.compact, undefined);
    assert.equal(result.instances.length, 1);
    assert.equal(result.instances[0].instanceId, 'selected');
    assert.equal(result.selectedEndpoint.source, 'discovery');
  });

  async function writeInstance(fileName, data) {
    await fsp.writeFile(path.join(registryDir, fileName), JSON.stringify({
      schemaVersion: 2,
      host: '127.0.0.1',
      port: 50123,
      pid: process.pid,
      unityVersion: '6000.3.11f1',
      packageVersion: '0.15.4',
      status: 'Connected',
      activeScene: 'SampleScene',
      lastSeen: new Date().toISOString(),
      ...data
    }));
  }
});
