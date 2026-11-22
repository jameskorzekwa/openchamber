import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { assertProjectMutationAllowed } from './primary-worktree-write-guard.js';

const roots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-write-guard-'));
  roots.push(root);
  return root;
}

function initializeRepository(root) {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('assertProjectMutationAllowed', () => {
  it('rejects a path inside a primary worktree', () => {
    const repository = makeTempRoot();
    initializeRepository(repository);
    const target = path.join(repository, '.opencode', 'agents', 'worker.md');

    expect(() => assertProjectMutationAllowed(target)).toThrow(expect.objectContaining({
      code: 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY',
      statusCode: 409,
    }));
  });

  it('allows a path inside a linked worktree', () => {
    const repository = makeTempRoot();
    initializeRepository(repository);
    const linked = makeTempRoot();
    fs.rmSync(linked, { recursive: true });
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', '-b', 'feature/test', linked]);

    expect(() => assertProjectMutationAllowed(
      path.join(linked, '.opencode', 'agents', 'worker.md'),
    )).not.toThrow();
  });

  it('allows a path outside a Git repository', () => {
    const root = makeTempRoot();

    expect(() => assertProjectMutationAllowed(path.join(root, 'worker.md'))).not.toThrow();
  });

  it('rejects a symlink that resolves into a primary worktree', () => {
    const repository = makeTempRoot();
    initializeRepository(repository);
    const external = makeTempRoot();
    fs.symlinkSync(repository, path.join(external, 'project'));

    expect(() => assertProjectMutationAllowed(
      path.join(external, 'project', '.opencode', 'agents', 'worker.md'),
    )).toThrow(expect.objectContaining({ code: 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY' }));
  });
});
