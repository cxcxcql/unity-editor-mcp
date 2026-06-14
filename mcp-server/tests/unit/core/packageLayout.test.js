import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Unity package layout', () => {
  it('should not track folder .meta files for empty package directories', () => {
    const trackedFiles = execFileSync('git', ['ls-files', 'unity-editor-mcp'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim().split('\n').filter(Boolean);
    const trackedFileSet = new Set(trackedFiles);

    const emptyFolderMetaFiles = trackedFiles.filter((file) => {
      if (!file.endsWith('.meta')) {
        return false;
      }

      const metaPath = `${repoRoot}${file}`;
      if (!existsSync(metaPath)) {
        return false;
      }

      if (!readFileSync(metaPath, 'utf8').includes('folderAsset: yes')) {
        return false;
      }

      const targetPath = file.slice(0, -'.meta'.length);
      const absoluteTargetPath = `${repoRoot}${targetPath}`;
      if (!existsSync(absoluteTargetPath)) {
        return true;
      }

      if (!statSync(absoluteTargetPath).isDirectory()) {
        return true;
      }

      return !trackedFiles.some((trackedFile) =>
        trackedFile !== file &&
        trackedFileSet.has(trackedFile) &&
        trackedFile.startsWith(`${targetPath}/`)
      );
    });

    assert.deepEqual(emptyFolderMetaFiles, []);
  });
});
