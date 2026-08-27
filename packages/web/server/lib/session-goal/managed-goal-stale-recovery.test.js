import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createManagedGoalStaleRecovery } from './managed-goal-stale-recovery.js';

const NOW = 2_000_000;
const STALE_MS = 100_000;
const OLD = NOW - STALE_MS - 1;

const managedRoot = (overrides = {}) => ({
  id: 'ses_root',
  directory: '/worktree',
  time: { created: OLD, updated: OLD },
  metadata: {
    openchamber: {
      goal: {
        id: 'goal_1',
        objective: 'Finish the work',
        managedWorktree: true,
        status: 'active',
        statusReason: '',
        turnsUsed: 7,
      },
    },
  },
  ...overrides,
});

const assistant = ({ id = 'msg_1', created = OLD, completed, error, parts = [] } = {}) => ({
  info: {
    id,
    role: 'assistant',
    time: { created, ...(completed ? { completed } : {}) },
    ...(error ? { error } : {}),
  },
  parts,
});

const createFixture = ({
  root = managedRoot(),
  child,
  rootMessage,
  childMessage,
  statuses = {},
  isEnabled,
  onAbort,
  patchFailures = 0,
} = {}) => {
  const sessions = new Map([[root.id, root]]);
  const messages = new Map([[root.id, rootMessage ?? assistant({ completed: OLD + 1 })]]);
  const children = new Map([[root.id, child ? [child] : []]]);
  if (child) {
    sessions.set(child.id, child);
    messages.set(child.id, childMessage ?? assistant());
    children.set(child.id, []);
  }
  const aborts = [];
  const patches = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return statuses;
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return messages.has(sessionId) ? [messages.get(sessionId)] : [];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      const message = messages.get(sessionId);
      if (message) {
        message.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
        message.info.time.completed = NOW;
      }
      onAbort?.(sessionId, sessions);
      return true;
    }
    if (options.method === 'PATCH') {
      if (patchFailures > 0) {
        patchFailures -= 1;
        throw new Error('transient patch failure');
      }
      patches.push({ sessionId, body: options.body });
      sessions.get(sessionId).metadata = options.body.metadata;
      return sessions.get(sessionId);
    }
    return sessions.get(sessionId) ?? null;
  };

  const warnings = [];
  const recovery = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => NOW,
    sleep: async () => {},
    ...(isEnabled ? { isEnabled } : {}),
    logger: { warn: (...args) => warnings.push(args) },
  });

  return { aborts, patches, recovery, root, sessions, warnings };
};

test('recovers a stale child stream omitted from session status', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const fixture = createFixture({ child, childMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_child']);
  assert.equal(fixture.patches.length, 0);
});

test('recovers the stale child before its orphaned foreground task parent', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootMessage = assistant({
    parts: [{
      type: 'tool',
      tool: 'task',
      state: { status: 'running', metadata: { sessionId: child.id } },
    }],
  });
  const fixture = createFixture({ child, childMessage: assistant(), rootMessage, statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_child']);
  assert.equal(fixture.patches.length, 0);

  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_child', 'ses_root']);
  assert.equal(fixture.patches.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'resumed');
  assert.equal(fixture.root.metadata.openchamber.goal.turnsUsed, 7);
});

test('recovers a stale direct parent stream and resumes the same goal', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.id, 'goal_1');
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'resumed');
});

test('does not abort a retrying stream', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: { ses_root: { type: 'retry' } } });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('does not abort a pending non-task tool', async () => {
  const rootMessage = assistant({
    parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', time: { start: OLD } } }],
  });
  const fixture = createFixture({ rootMessage, statuses: { ses_root: { type: 'busy' } } });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('does not abort a recent incomplete stream', async () => {
  const fixture = createFixture({
    root: managedRoot({ time: { created: NOW - 1_000, updated: NOW - 1_000 } }),
    rootMessage: assistant({ created: NOW - 1_000 }),
    statuses: { ses_root: { type: 'busy' } },
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('fails closed when session status is unavailable', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: null });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('does not monitor goals held during a worktree move', async () => {
  const root = managedRoot();
  root.metadata.openchamber.goal.statusReason = 'worktree-moving';
  const fixture = createFixture({ root, rootMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('does nothing while session goals are disabled', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: {}, isEnabled: () => false });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('does not override an explicit user pause after recovery starts', async () => {
  const fixture = createFixture({
    rootMessage: assistant(),
    statuses: {},
    onAbort: (sessionId, sessions) => {
      if (sessionId !== 'ses_root') return;
      const goal = sessions.get(sessionId).metadata.openchamber.goal;
      goal.status = 'paused';
      goal.statusReason = 'paused by user';
    },
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 0);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'paused');
});

test('retries a transient goal resume write without aborting twice', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: {}, patchFailures: 1 });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 0);

  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'resumed');
});
