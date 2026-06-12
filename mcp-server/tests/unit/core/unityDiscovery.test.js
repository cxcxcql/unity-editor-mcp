import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  findUnityProjectRoot,
  normalizeProjectPath,
  readUnityInstances,
  resolveUnityEndpoint,
  selectUnityInstance
} from '../../../src/core/unityDiscovery.js';

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

  async function writeInstance(fileName, data) {
    await fsp.writeFile(path.join(registryDir, fileName), JSON.stringify({
      schemaVersion: 1,
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
