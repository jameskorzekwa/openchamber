import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { watchWorktreeChanges } from './worktree-change-watcher.js';

const execFile = promisify(execFileCallback);

const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for worktree watcher');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test('detects external worktree add and remove', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-watcher-test-'));
  const worktree = `${root}-linked`;
  try {
    await execFile('git', ['init', '-b', 'main', root]);
    await execFile('git', ['-C', root, 'config', 'user.name', 'Test User']);
    await execFile('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await writeFile(path.join(root, 'README.md'), 'initial\n');
    await execFile('git', ['-C', root, 'add', 'README.md']);
    await execFile('git', ['-C', root, 'commit', '-m', 'Initial']);

    const events = [];
    const unsubscribe = await watchWorktreeChanges(root, (event) => events.push(event));
    await execFile('git', ['-C', root, 'worktree', 'add', '-b', 'test/watcher', worktree, 'HEAD']);
    await waitFor(() => events.length >= 1);
    await execFile('git', ['-C', root, 'worktree', 'remove', worktree]);
    await waitFor(() => events.length >= 2);
    unsubscribe();

    expect(events.every((event) => typeof event.at === 'number')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});
