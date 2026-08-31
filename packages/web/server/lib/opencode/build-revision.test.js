import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isValidBuildRevision, resolveBuildRevision, resolveRuntimeBuildRevision } from './build-revision.js';

const temporaryDirectories = [];

const writeRevisionFile = (content) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-build-revision-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'build-revision.json');
  fs.writeFileSync(filePath, content);
  return filePath;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('build revision resolver', () => {
  it('uses environment, generated file, and package version in precedence order', () => {
    const revisionFilePath = writeRevisionFile('{"revision":"file-revision"}\n');

    expect(resolveRuntimeBuildRevision({
      env: { OPENCHAMBER_BUILD_REVISION: 'env-revision' },
      revisionFilePath,
      packageVersion: '1.21.0',
    })).toBe('env-revision');
    expect(resolveRuntimeBuildRevision({ env: {}, revisionFilePath, packageVersion: '1.21.0' })).toBe('file-revision');
    expect(resolveRuntimeBuildRevision({ env: {}, revisionFilePath: `${revisionFilePath}.missing`, packageVersion: '1.21.0' })).toBe('1.21.0');
  });

  it('rejects malformed files and unsafe revisions', () => {
    const malformedFile = writeRevisionFile('{not-json');
    const unsafeFile = writeRevisionFile('{"revision":"bad revision"}');

    expect(resolveRuntimeBuildRevision({ env: {}, revisionFilePath: malformedFile, packageVersion: '1.21.0' })).toBe('1.21.0');
    expect(resolveRuntimeBuildRevision({ env: {}, revisionFilePath: unsafeFile, packageVersion: '1.21.0' })).toBe('1.21.0');
    expect(resolveRuntimeBuildRevision({
      env: { OPENCHAMBER_BUILD_REVISION: '../escape' },
      revisionFilePath: unsafeFile,
      packageVersion: '1.21.0',
    })).toBe('1.21.0');
    expect(isValidBuildRevision('a'.repeat(129))).toBe(false);
  });

  it('uses the same validated precedence for build-time inputs', () => {
    expect(resolveBuildRevision({ envRevision: 'release+1', gitRevision: 'a'.repeat(40), packageVersion: '1.21.0' })).toBe('release+1');
    expect(resolveBuildRevision({ envRevision: 'bad value', gitRevision: 'a'.repeat(40), packageVersion: '1.21.0' })).toBe('a'.repeat(40));
  });
});
