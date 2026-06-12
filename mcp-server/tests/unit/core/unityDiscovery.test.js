import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import {
  createDiscoveryReport,
  findUnityProjectRoot,
  getLocalWorkspaceIdentity,
  normalizeProjectPath,
  readUnityInstances,
  resolveUnityEndpoint,
  selectUnityInstance
} from '../../../src/core/unityDiscovery.js';

const execFileAsync = promisify(execFile);

describe('Unity discovery', () => {
  let tempDir;
  let registryDir;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'unity-mcp-discovery-'));
    registryDir = path.join(tempDir, 'instances');
    await fsp.mkdir(registryDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('normalizes project paths and strips Assets suffix', () => {
    const projectPath = path.join(tempDir, 'Project');
    assert.equal(normalizeProjectPath(path.join(projectPath, 'Assets')), projectPath);
  });

  it('finds a Unity project root from a nested cwd', async () => {
    const projectPath = path.join(tempDir, 'GameProject');
    const nestedPath = path.join(projectPath, 'Assets', 'Scripts');
    await fsp.mkdir(nestedPath, { recursive: true });
    await fsp.mkdir(path.join(projectPath, 'ProjectSettings'), { recursive: true });

    assert.equal(findUnityProjectRoot(nestedPath), projectPath);
  });

  it('reads only live fresh registry entries by default', async () => {
    const liveProject = path.join(tempDir, 'LiveProject');
    const staleProject = path.join(tempDir, 'StaleProject');
    await writeInstance('live.json', {
      projectPath: liveProject,
      pid: process.pid,
      port: 50123,
      lastSeen: new Date().toISOString()
    });
    await writeInstance('stale.json', {
      projectPath: staleProject,
      pid: process.pid,
      port: 50124,
      lastSeen: new Date(Date.now() - 120000).toISOString()
    });
    await writeInstance('dead.json', {
      projectPath: path.join(tempDir, 'DeadProject'),
      pid: 99999999,
      port: 50125,
      lastSeen: new Date().toISOString()
    });

    const instances = await readUnityInstances({ registryDir, staleAfterMs: 30000 });

    assert.equal(instances.length, 1);
    assert.equal(instances[0].projectPath, liveProject);
    assert.equal(instances[0].port, 50123);
  });

  it('selects the instance matching an explicit project path', async () => {
    const projectA = path.join(tempDir, 'ProjectA');
    const projectB = path.join(tempDir, 'ProjectB');
    const instances = [
      createInstance(projectA, 50123),
      createInstance(projectB, 50124)
    ];

    const selection = selectUnityInstance(instances, { projectPath: projectB });

    assert.equal(selection.instance.projectPath, projectB);
    assert.equal(selection.reason, 'explicit project path');
  });

  it('selects the instance matching an explicit instance ID', () => {
    const projectA = path.join(tempDir, 'ProjectA');
    const projectB = path.join(tempDir, 'ProjectB');
    const instances = [
      { ...createInstance(projectA, 50123), instanceId: 'unity-a' },
      { ...createInstance(projectB, 50124), instanceId: 'unity-b' }
    ];

    const selection = selectUnityInstance(instances, { instanceId: 'unity-b' });

    assert.equal(selection.instance.projectPath, projectB);
    assert.equal(selection.reason, 'explicit instance ID');
  });

  it('selects the instance matching an explicit workspace ID', () => {
    const projectA = path.join(tempDir, 'ProjectA');
    const projectB = path.join(tempDir, 'ProjectB');
    const instances = [
      { ...createInstance(projectA, 50123), workspaceId: 'workspace-a' },
      { ...createInstance(projectB, 50124), workspaceId: 'workspace-b' }
    ];

    const selection = selectUnityInstance(instances, { workspaceId: 'workspace-b' });

    assert.equal(selection.instance.projectPath, projectB);
    assert.equal(selection.reason, 'explicit workspace ID');
  });

  it('refuses to select a different worktree from the same Git repository', () => {
    const targetProject = path.join(tempDir, 'TargetProject');
    const openProject = path.join(tempDir, 'OpenProject');
    const instances = [
      {
        ...createInstance(openProject, 50123),
        workspaceId: 'open-workspace',
        git: {
          commonDir: path.join(tempDir, 'repo', '.git'),
          gitDir: path.join(tempDir, 'repo', '.git', 'worktrees', 'open'),
          branch: 'codex/open'
        }
      }
    ];

    assert.throws(
      () => selectUnityInstance(instances, {
        localWorkspace: {
          projectPath: targetProject,
          normalizedProjectPath: normalizeProjectPath(targetProject),
          workspaceId: 'target-workspace',
          git: {
            commonDir: path.join(tempDir, 'repo', '.git'),
            gitDir: path.join(tempDir, 'repo', '.git', 'worktrees', 'target'),
            branch: 'codex/target'
          }
        }
      }),
      (error) => {
        assert.equal(error.code, 'WORKTREE_MISMATCH');
        assert.match(error.message, /same Git repository/i);
        assert.match(error.message, /OpenProject/);
        return true;
      }
    );
  });

  it('refuses single live fallback when a local workspace is inferred', () => {
    const openProject = path.join(tempDir, 'OpenProject');
    const instances = [
      {
        ...createInstance(openProject, 50123),
        workspaceId: 'open-workspace',
        git: {
          commonDir: path.join(tempDir, 'other-repo', '.git')
        }
      }
    ];

    assert.throws(
      () => selectUnityInstance(instances, {
        localWorkspace: {
          projectPath: path.join(tempDir, 'TargetProject'),
          normalizedProjectPath: normalizeProjectPath(path.join(tempDir, 'TargetProject')),
          workspaceId: 'target-workspace',
          git: {
            commonDir: path.join(tempDir, 'repo', '.git')
          }
        }
      }),
      (error) => {
        assert.equal(error.code, 'LOCAL_WORKSPACE_MISMATCH');
        assert.match(error.message, /No Unity Editor MCP instance matches the current Unity workspace/);
        assert.match(error.message, /OpenProject/);
        return true;
      }
    );
  });

  it('allows single live fallback when explicitly enabled for a local workspace', () => {
    const openProject = path.join(tempDir, 'OpenProject');
    const instances = [
      {
        ...createInstance(openProject, 50123),
        workspaceId: 'open-workspace',
        git: {
          commonDir: path.join(tempDir, 'other-repo', '.git')
        }
      }
    ];

    const selection = selectUnityInstance(instances, {
      allowSingleInstanceFallback: true,
      localWorkspace: {
        projectPath: path.join(tempDir, 'TargetProject'),
        normalizedProjectPath: normalizeProjectPath(path.join(tempDir, 'TargetProject')),
        workspaceId: 'target-workspace',
        git: {
          commonDir: path.join(tempDir, 'repo', '.git')
        }
      }
    });

    assert.equal(selection.instance.projectPath, openProject);
    assert.equal(selection.reason, 'single live Unity instance');
  });

  it('keeps single live fallback when no local workspace is inferred', () => {
    const openProject = path.join(tempDir, 'OpenProject');
    const instances = [
      createInstance(openProject, 50123)
    ];

    const selection = selectUnityInstance(instances, { cwd: tempDir });

    assert.equal(selection.instance.projectPath, openProject);
    assert.equal(selection.reason, 'single live Unity instance');
  });

  it('reports the WORKTREE_MISMATCH code for related worktree candidates', async () => {
    const commonDir = path.join(tempDir, 'repo', '.git');
    await writeInstance('open.json', {
      projectPath: path.join(tempDir, 'OpenProject'),
      workspaceId: 'open-workspace',
      git: {
        commonDir,
        gitDir: path.join(commonDir, 'worktrees', 'open'),
        branch: 'codex/open'
      },
      pid: process.pid,
      port: 50123,
      lastSeen: new Date().toISOString()
    });

    const report = await createDiscoveryReport({
      unityConfig: {
        host: 'localhost',
        port: 6400,
        discovery: {
          registryDir,
          enabled: true
        }
      },
      cwd: tempDir,
      localWorkspace: {
        projectPath: path.join(tempDir, 'TargetProject'),
        workspaceId: 'target-workspace',
        git: {
          commonDir,
          gitDir: path.join(commonDir, 'worktrees', 'target'),
          branch: 'codex/target'
        }
      }
    });

    assert.equal(report.endpoint, null);
    assert.equal(report.errorCode, 'WORKTREE_MISMATCH');
    assert.match(report.error, /same Git repository/i);
  });

  it('refuses to guess when multiple live instances are available', () => {
    const instances = [
      createInstance(path.join(tempDir, 'ProjectA'), 50123),
      createInstance(path.join(tempDir, 'ProjectB'), 50124)
    ];

    assert.throws(
      () => selectUnityInstance(instances, { cwd: tempDir }),
      /Multiple Unity Editor MCP instances are running/
    );
  });

  it('falls back to the default port when no registry entries exist', async () => {
    const endpoint = await resolveUnityEndpoint({
      unityConfig: {
        host: 'localhost',
        port: 6400,
        hasExplicitPort: false,
        discovery: { registryDir, enabled: true }
      },
      cwd: tempDir
    });

    assert.equal(endpoint.host, 'localhost');
    assert.equal(endpoint.port, 6400);
    assert.equal(endpoint.source, 'default-port');
  });

  it('prefers the last discovered endpoint when it is still connectable', async () => {
    const endpoint = await resolveUnityEndpoint({
      unityConfig: {
        host: 'localhost',
        port: 6400,
        hasExplicitPort: false,
        discovery: { registryDir, enabled: true }
      },
      lastEndpoint: {
        host: '127.0.0.1',
        port: 50123,
        source: 'discovery',
        reason: 'current Unity project',
        instance: {
          pid: process.pid,
          host: '127.0.0.1',
          port: 50123
        }
      },
      canConnectToPort: async (host, port) => host === '127.0.0.1' && port === 50123,
      cwd: tempDir
    });

    assert.equal(endpoint.port, 50123);
    assert.equal(endpoint.source, 'cached-endpoint');
  });

  it('uses a stale exact project match during reload when its port is connectable', async () => {
    const projectPath = path.join(tempDir, 'ReloadingProject');
    await writeInstance('reloading.json', {
      instanceId: 'unity-reloading',
      projectPath,
      pid: process.pid,
      port: 50123,
      lastSeen: new Date(Date.now() - 120000).toISOString()
    });

    const endpoint = await resolveUnityEndpoint({
      unityConfig: {
        host: 'localhost',
        port: 6400,
        hasExplicitPort: false,
        discovery: {
          registryDir,
          enabled: true,
          projectPath
        }
      },
      canConnectToPort: async (host, port) => host === '127.0.0.1' && port === 50123,
      cwd: tempDir
    });

    assert.equal(endpoint.port, 50123);
    assert.equal(endpoint.reason, 'stale exact project path');
    assert.equal(endpoint.instance.stale, true);
  });

  it('uses explicit port without discovery', async () => {
    const endpoint = await resolveUnityEndpoint({
      unityConfig: {
        host: '127.0.0.1',
        port: 6500,
        hasExplicitPort: true,
        discovery: { registryDir, enabled: true }
      },
      cwd: tempDir
    });

    assert.equal(endpoint.host, '127.0.0.1');
    assert.equal(endpoint.port, 6500);
    assert.equal(endpoint.source, 'explicit-port');
  });

  it('reads stable distinct workspace IDs from Git main and linked worktrees', async (t) => {
    try {
      await execFileAsync('git', ['--version']);
    } catch {
      t.skip('git is not available');
      return;
    }

    const repoPath = path.join(tempDir, 'RepoProject');
    const linkedPath = path.join(tempDir, 'RepoProject-linked');
    await fsp.mkdir(path.join(repoPath, 'Assets'), { recursive: true });
    await fsp.mkdir(path.join(repoPath, 'ProjectSettings'), { recursive: true });
    await fsp.writeFile(path.join(repoPath, 'Assets', '.keep'), '');
    await fsp.writeFile(path.join(repoPath, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.11f1\n');

    await execFileAsync('git', ['init', '-q'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
    await execFileAsync('git', ['add', 'Assets', 'ProjectSettings'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repoPath });
    await execFileAsync('git', ['worktree', 'add', '-q', linkedPath, '-b', 'linked'], { cwd: repoPath });

    const mainIdentity = await getLocalWorkspaceIdentity(repoPath);
    const linkedIdentity = await getLocalWorkspaceIdentity(linkedPath);
    const mainIdentityAgain = await getLocalWorkspaceIdentity(repoPath);

    assert.equal(mainIdentity.projectPath, repoPath);
    assert.equal(linkedIdentity.projectPath, linkedPath);
    assert.equal(mainIdentity.workspaceId, mainIdentityAgain.workspaceId);
    assert.notEqual(mainIdentity.workspaceId, linkedIdentity.workspaceId);
    assert.equal(mainIdentity.git.commonDir, linkedIdentity.git.commonDir);
    assert.notEqual(mainIdentity.git.gitDir, linkedIdentity.git.gitDir);
  });

  async function writeInstance(fileName, data) {
    await fsp.writeFile(path.join(registryDir, fileName), JSON.stringify({
      schemaVersion: 2,
      host: '127.0.0.1',
      unityVersion: '6000.3.11f1',
      packageVersion: '0.15.4',
      status: 'Disconnected',
      ...data
    }));
  }

  function createInstance(projectPath, port) {
    return {
      projectPath,
      normalizedProjectPath: normalizeProjectPath(projectPath),
      pid: process.pid,
      host: '127.0.0.1',
      port,
      stale: false,
      alive: true,
      lastSeen: new Date().toISOString()
    };
  }
});
