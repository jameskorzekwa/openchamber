import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

class PrimaryWorktreeMutationError extends Error {
  readonly code = 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY';
  readonly statusCode = 409;
}

function findWorktreeRoot(startDirectory: string) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveTargetPath(targetPath: string) {
  let candidate = path.resolve(targetPath);
  for (let symlinkDepth = 0; symlinkDepth < 40; symlinkDepth += 1) {
    let current = candidate;
    const missingSegments = [];
    while (true) {
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) return candidate;
        missingSegments.unshift(path.basename(current));
        current = parent;
        continue;
      }
      if (stat.isSymbolicLink()) {
        candidate = path.resolve(path.dirname(current), fs.readlinkSync(current), ...missingSegments);
        break;
      }
      return path.join(fs.realpathSync(current), ...missingSegments);
    }
  }
  throw new Error(`Too many symbolic links while resolving OpenChamber mutation target: ${targetPath}`);
}

function isLinkedWorktree(root: string) {
  try {
    const output = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const [gitDirectory, commonDirectory] = output.trim().split(/\r?\n/);
    return Boolean(gitDirectory && commonDirectory && path.resolve(gitDirectory) !== path.resolve(commonDirectory));
  } catch {
    return false;
  }
}

export function assertProjectMutationAllowed(targetPath: string) {
  const lexicalTargetPath = path.resolve(targetPath);
  const resolvedTargetPath = resolveTargetPath(targetPath);
  const roots = Array.from(new Set([
    findWorktreeRoot(path.dirname(lexicalTargetPath)),
    findWorktreeRoot(path.dirname(resolvedTargetPath)),
  ].filter((root) => root !== null)));
  if (roots.length === 0 || roots.every(isLinkedWorktree)) return;

  throw new PrimaryWorktreeMutationError(`OpenChamber refuses to modify project configuration in the primary worktree: ${targetPath}`);
}
