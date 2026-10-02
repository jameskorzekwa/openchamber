import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManagedGoalStaleRecovery } from './managed-goal-stale-recovery.js';
import { hasNonterminalChildTool, hasUnresolvedManagedRecovery, isLegacyRecoveryHold } from './legacy-recovery-compatibility.js';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test.each(['aborting', 'delivery'])('v2 leaves a persisted %s journal untouched without invoking any worker dependency', async (phase) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-disabled-'));
  directories.push(directory);
  const journal = {
    version: 1, rootId: 'ses_root', goalId: 'goal_1', directory: '/repo', phase,
    target: { sessionId: 'ses_root', messageId: 'msg_old', taskPartId: '', taskCallId: '', taskChildSessionId: '', parentSessionId: '', parentMessageId: '' },
    attempts: 3, nextAttemptAt: 0, deliveryMessageId: 'msg_recovery', deliveryPrompt: 'Continue', deliveryAttemptedAt: 1, deliveryAttempts: 1,
  };
  const file = path.join(directory, 'ses_root.goal-recovery.json');
  const original = JSON.stringify(journal);
  await writeFile(file, original);
  const forbidden = () => { throw new Error('unsupported worker invoked a dependency'); };
  const worker = createManagedGoalStaleRecovery({
    stateDirectory: directory, openCodeFetch: forbidden, buildRecoveryPrompt: forbidden,
    isEnabled: forbidden, setIntervalImpl: forbidden, clearIntervalImpl: forbidden,
  });
  expect(worker.supported).toBe(false);
  worker.start();
  worker.observe({ sessionId: 'ses_root', goal: { managedWorktree: true, status: 'active' } });
  await worker.discoverNow();
  await worker.scanNow();
  worker.stop();
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await hasUnresolvedManagedRecovery('ses_root', { stateDirectory: directory })).toBe(true);
});

test('missing journals permit normal goals, malformed journals remain blocking', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-disabled-'));
  directories.push(directory);
  expect(await hasUnresolvedManagedRecovery('ses_root', { stateDirectory: directory })).toBe(false);
  const file = path.join(directory, 'ses_root.goal-recovery.json');
  await writeFile(file, '{broken');
  expect(await hasUnresolvedManagedRecovery('ses_root', { stateDirectory: directory })).toBe(true);
  expect(await readFile(file, 'utf8')).toBe('{broken');
  expect(isLegacyRecoveryHold({ statusReason: 'stale-recovery:msg_1' })).toBe(true);
  expect(isLegacyRecoveryHold({ statusReason: 'resumed' })).toBe(false);
});

test.each(['streaming', 'running', undefined])('a v2 subagent tool with status %s cannot be bypassed', (status) => {
  expect(hasNonterminalChildTool([{ type: 'tool', name: 'subagent', state: { status, metadata: { sessionID: 'ses_child' } } }])).toBe(true);
});

test.each(['completed', 'error'])('a terminal child tool with status %s permits ordinary goal work', (status) => {
  expect(hasNonterminalChildTool([{ type: 'tool', name: 'subagent', state: { status } }])).toBe(false);
});
