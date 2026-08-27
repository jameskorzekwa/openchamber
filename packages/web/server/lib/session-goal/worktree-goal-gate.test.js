import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { readManagedWorktreeGoalGate, readManagedWorktreeGoalRecord, writeManagedWorktreeGoalProgress } from './worktree-goal-gate.js';

test('keeps managed goals active until deployment, cleanup, and primary return complete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-goal-gate-test-'));
  try {
    await mkdir(root, { recursive: true });
    const statePath = path.join(root, 'ses_goal.json');
    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessionID: 'ses_goal',
      managedGoalID: 'goal_1',
      managedGoal: { id: 'goal_1', managedWorktree: true, status: 'active' },
      phase: 'attached',
    }));
    assert.deepEqual(await readManagedWorktreeGoalGate('ses_goal', 'goal_1', { stateDirectory: root }), {
      complete: false,
      note: 'Finish implementation and provide verified dev deployment evidence before returning to the primary workspace.',
    });
    assert.equal((await readManagedWorktreeGoalRecord('ses_goal', { stateDirectory: root })).protected, true);
    await writeManagedWorktreeGoalProgress('ses_goal', {
      id: 'goal_1',
      managedWorktree: true,
      status: 'active',
      turnsUsed: 7,
      tokensUsed: 123,
    }, { stateDirectory: root });
    assert.deepEqual(await readManagedWorktreeGoalRecord('ses_goal', { stateDirectory: root }), {
      goal: { id: 'goal_1', managedWorktree: true, status: 'active', turnsUsed: 7, tokensUsed: 123 },
      protected: true,
    });
    await writeFile(path.join(root, 'ses_goal.goal.json'), JSON.stringify({
      id: 'goal_stale',
      managedWorktree: true,
      status: 'active',
    }));
    assert.equal((await readManagedWorktreeGoalRecord('ses_goal', { stateDirectory: root })).goal.id, 'goal_1');

    await writeFile(statePath, JSON.stringify({
      version: 1,
      sessionID: 'ses_goal',
      managedGoalID: 'goal_1',
      managedGoal: { id: 'goal_1', managedWorktree: true, status: 'active' },
      phase: 'goal-completion-pending',
      devDeployment: { target: 'https://dev.example.test/health', commit: 'a'.repeat(40), status: 200, bodySha256: 'b'.repeat(64), verifiedAt: Date.now() },
    }));
    assert.deepEqual(await readManagedWorktreeGoalGate('ses_goal', 'goal_1', { stateDirectory: root }), {
      complete: true,
      note: 'Implementation, dev deployment, merge, cleanup, and return to the primary workspace are complete.',
    });
    assert.equal((await readManagedWorktreeGoalRecord('ses_goal', { stateDirectory: root })).protected, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed for missing or mismatched lifecycle state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worktree-goal-gate-test-'));
  try {
    assert.equal((await readManagedWorktreeGoalGate('ses_missing', 'goal_1', { stateDirectory: root })).complete, false);
    await writeFile(path.join(root, 'ses_goal.json'), JSON.stringify({
      version: 1,
      managedGoalID: 'goal_other',
      phase: 'complete',
      devDeployment: { target: 'https://dev.example.test/health', commit: 'a'.repeat(40), status: 200, bodySha256: 'b'.repeat(64), verifiedAt: Date.now() },
    }));
    assert.equal((await readManagedWorktreeGoalGate('ses_goal', 'goal_1', { stateDirectory: root })).complete, false);
    assert.equal((await readManagedWorktreeGoalGate('../escape', 'goal_1', { stateDirectory: root })).complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
