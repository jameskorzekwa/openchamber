import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { updateAgent } from './agents.js';

const temporaryDirectories = [];
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;

const makeTemporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agent-prompt-'));
  temporaryDirectories.push(directory);
  return directory;
};

const configureAgentPrompt = (root, promptPath) => {
  const configPath = path.join(root, 'opencode.json');
  fs.writeFileSync(configPath, JSON.stringify({
    agent: { guarded: { prompt: `{file:${promptPath}}` } },
  }));
  process.env.OPENCODE_CONFIG = configPath;
};

const initializeRepository = (root) => {
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['-C', root, 'add', 'tracked.txt'], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', root,
    '-c', 'user.name=OpenChamber Test',
    '-c', 'user.email=openchamber@example.test',
    'commit', '-m', 'fixture',
  ], { stdio: 'ignore' });
};

afterEach(() => {
  if (originalOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG;
  else process.env.OPENCODE_CONFIG = originalOpenCodeConfig;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('agent prompt-file mutation guard', () => {
  it('rejects an absolute prompt target in a primary worktree through updateAgent', () => {
    const fixture = makeTemporaryDirectory();
    const repository = path.join(fixture, 'primary');
    fs.mkdirSync(repository);
    initializeRepository(repository);
    const promptPath = path.join(repository, 'agent-prompt.md');
    fs.writeFileSync(promptPath, 'original');
    configureAgentPrompt(fixture, promptPath);

    expect(() => updateAgent('guarded', { prompt: 'replacement' }, fixture)).toThrow(expect.objectContaining({
      code: 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY',
      statusCode: 409,
    }));
    expect(fs.readFileSync(promptPath, 'utf8')).toBe('original');
  });

  it('allows absolute prompt targets in linked worktrees and non-repositories', () => {
    const fixture = makeTemporaryDirectory();
    const repository = path.join(fixture, 'primary');
    const linked = path.join(fixture, 'linked');
    fs.mkdirSync(repository);
    initializeRepository(repository);
    execFileSync('git', ['-C', repository, 'worktree', 'add', '-b', 'prompt-test', linked], { stdio: 'ignore' });

    const linkedPrompt = path.join(linked, 'agent-prompt.md');
    configureAgentPrompt(fixture, linkedPrompt);
    updateAgent('guarded', { prompt: 'linked replacement' }, fixture);
    expect(fs.readFileSync(linkedPrompt, 'utf8')).toBe('linked replacement');

    const plainPrompt = path.join(fixture, 'plain', 'agent-prompt.md');
    configureAgentPrompt(fixture, plainPrompt);
    updateAgent('guarded', { prompt: 'plain replacement' }, fixture);
    expect(fs.readFileSync(plainPrompt, 'utf8')).toBe('plain replacement');
  });
});
