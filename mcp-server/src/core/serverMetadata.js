import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
const packageRoot = path.dirname(packageJsonPath);
const repoRoot = path.dirname(packageRoot);

let cachedPackage = null;
let cachedGitHead = null;

export function getServerMetadata() {
  const pkg = readPackageJson();

  return {
    packageName: pkg.name,
    packageVersion: pkg.version,
    gitHead: readGitHead(),
    entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : null,
    pid: process.pid,
    nodeVersion: process.version
  };
}

function readPackageJson() {
  if (!cachedPackage) {
    cachedPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  }

  return cachedPackage;
}

function readGitHead() {
  if (cachedGitHead !== null) {
    return cachedGitHead;
  }

  try {
    cachedGitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    cachedGitHead = 'unknown';
  }

  return cachedGitHead;
}
