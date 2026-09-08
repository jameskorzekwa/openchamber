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

test('no-op abort does not log recovered and backs off retries', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    onAbort: () => {
      // Abort succeeds but does not settle the message (no-op)
    },
  });
  // Override now to control backoff timing
  const originalNow = fixture.recovery;
  // Re-create with controllable time
  const sessions = new Map([['ses_root', managedRoot()]]);
  const messages = new Map([['ses_root', assistant({ id: 'msg_stale' })]]);
  const children = new Map([['ses_root', []]]);
  const aborts = [];
  const warnings = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return {};
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return messages.has(sessionId) ? [messages.get(sessionId)] : [];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      // No-op: do not stamp error or completion
      return true;
    }
    if (options.method === 'PATCH') {
      sessions.get(sessionId).metadata = options.body.metadata;
      return sessions.get(sessionId);
    }
    return sessions.get(sessionId) ?? null;
  };

  const recovery = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => currentTime,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  await recovery.discoverNow();

  // First scan: abort attempt, should not log 'recovered'
  await recovery.scanNow();
  assert.equal(aborts.length, 1);
  assert.ok(warnings.some((w) => w[0].includes('abort did not settle')));
  assert.ok(!warnings.some((w) => w[0].includes('recovered stale')));

  // Second scan immediately: should skip due to backoff
  await recovery.scanNow();
  assert.equal(aborts.length, 1); // No new abort

  // Advance time past backoff (1 minute)
  currentTime += 61_000;
  await recovery.scanNow();
  assert.equal(aborts.length, 2); // Second attempt

  // Advance past second backoff (2 minutes)
  currentTime += 121_000;
  await recovery.scanNow();
  assert.equal(aborts.length, 3);

  // Advance past third backoff (4 minutes)
  currentTime += 241_000;
  await recovery.scanNow();
  assert.equal(aborts.length, 4);

  // Advance past fourth backoff (8 minutes)
  currentTime += 481_000;
  await recovery.scanNow();
  assert.equal(aborts.length, 5);

  // Fifth attempt exhausts retries
  assert.ok(warnings.some((w) => w[0].includes('abort exhausted')));

  // Further scans should skip this message
  currentTime += 3600_000;
  await recovery.scanNow();
  assert.equal(aborts.length, 5); // No more attempts

  // Never logged 'recovered'
  assert.ok(!warnings.some((w) => w[0].includes('recovered stale')));
});

test('recovery process restart resets retry state', async () => {
  let currentTime = NOW;
  const sessions = new Map([['ses_root', managedRoot()]]);
  const messages = new Map([['ses_root', assistant({ id: 'msg_stale' })]]);
  const children = new Map([['ses_root', []]]);
  const aborts = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return {};
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return messages.has(sessionId) ? [messages.get(sessionId)] : [];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      return true;
    }
    if (options.method === 'PATCH') {
      sessions.get(sessionId).metadata = options.body.metadata;
      return sessions.get(sessionId);
    }
    return sessions.get(sessionId) ?? null;
  };

  // First recovery instance
  const recovery1 = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => currentTime,
    sleep: async () => {},
    logger: { warn: () => {} },
  });

  await recovery1.discoverNow();
  await recovery1.scanNow();
  assert.equal(aborts.length, 1);

  // Stop first instance
  recovery1.stop();

  // Second recovery instance (simulates process restart)
  const recovery2 = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => currentTime,
    sleep: async () => {},
    logger: { warn: () => {} },
  });

  // Should attempt immediately since retry state was cleared
  await recovery2.discoverNow();
  await recovery2.scanNow();
  assert.equal(aborts.length, 2);
});

test('genuine completed child still recovers parent correctly', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootMessage = assistant({
    id: 'msg_parent',
    parts: [{
      id: 'call_task1',
      type: 'tool',
      tool: 'task',
      state: { status: 'running', metadata: { sessionId: child.id } },
    }],
  });
  // Child message is already completed (genuine settlement)
  const childMessage = assistant({ id: 'msg_child', completed: OLD + 1 });
  const fixture = createFixture({ child, childMessage, rootMessage, statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  // Child is already settled, so recovery should target the parent
  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'resumed');
});

test('busy child prevents parent task from being recognized as orphaned', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootMessage = assistant({
    id: 'msg_parent',
    parts: [{
      id: 'call_task1',
      type: 'tool',
      tool: 'task',
      state: { status: 'running', metadata: { sessionId: child.id } },
    }],
  });
  // Child is incomplete but busy - it's actively running
  const childMessage = assistant({ id: 'msg_child', completed: NOW + 1 }); // Recent completion
  const fixture = createFixture({
    child,
    childMessage,
    rootMessage,
    statuses: { ses_child: { type: 'busy' } },
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  // busy child prevents taskPointsToTerminalChild from returning true
  // so the parent's pending tool check prevents it from being recovered as orphaned task
  // and the root has pending tools so it's skipped
  assert.deepEqual(fixture.aborts, []);
});

test('does not abort when descendant has pending ordinary tool', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const childMessage = assistant({
    parts: [{ type: 'tool', tool: 'bash', state: { status: 'running', time: { start: OLD } } }],
  });
  const fixture = createFixture({
    child,
    childMessage,
    statuses: { ses_child: { type: 'busy' } },
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
});

test('handles new user message replacing stale assistant', async () => {
  const sessions = new Map([['ses_root', managedRoot()]]);
  // Start with stale assistant
  let currentMessage = assistant({ id: 'msg_stale' });
  const messages = new Map([['ses_root', currentMessage]]);
  const children = new Map([['ses_root', []]]);
  const aborts = [];
  const warnings = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return {};
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return [messages.get(sessionId)];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      return true;
    }
    if (options.method === 'PATCH') {
      sessions.get(sessionId).metadata = options.body.metadata;
      return sessions.get(sessionId);
    }
    return sessions.get(sessionId) ?? null;
  };

  const recovery = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => NOW,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  await recovery.discoverNow();
  await recovery.scanNow();
  assert.equal(aborts.length, 1);

  // Simulate new user message (different messageId)
  messages.set('ses_root', { info: { id: 'msg_new', role: 'user', time: { created: NOW } }, parts: [] });

  // Next scan should not target the old message (user message is not an incomplete assistant)
  await recovery.scanNow();
  assert.equal(aborts.length, 1); // No new abort
});

test('respects replaced goal by not recovering old goal sessions', async () => {
  const root = managedRoot();
  const originalGoalId = root.metadata.openchamber.goal.id;
  const fixture = createFixture({ root, rootMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();

  // Replace the goal before scan
  root.metadata.openchamber.goal.id = 'goal_replaced';

  await fixture.recovery.scanNow();

  // Abort should happen but resume should check goal ID
  // Since goalId changed, recovery state key differs, so new abort attempt is allowed
  assert.equal(fixture.aborts.length, 1);
  // The patch should update the new goal
  assert.equal(fixture.root.metadata.openchamber.goal.id, 'goal_replaced');
});

test('no-op abort for child does not strand parent with orphaned task', async () => {
  let currentTime = NOW;
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootSession = managedRoot();
  const sessions = new Map([
    ['ses_root', rootSession],
    ['ses_child', child],
  ]);
  const rootMessage = assistant({
    id: 'msg_parent',
    parts: [{
      id: 'call_task1',
      type: 'tool',
      tool: 'task',
      state: { status: 'running', metadata: { sessionId: child.id } },
    }],
  });
  const childMessage = assistant({ id: 'msg_child' });
  const messages = new Map([
    ['ses_root', rootMessage],
    ['ses_child', childMessage],
  ]);
  const children = new Map([
    ['ses_root', [child]],
    ['ses_child', []],
  ]);
  const aborts = [];
  const warnings = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return {};
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return messages.has(sessionId) ? [messages.get(sessionId)] : [];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      // No-op abort for child
      return true;
    }
    if (options.method === 'PATCH') {
      sessions.get(sessionId).metadata = options.body.metadata;
      return sessions.get(sessionId);
    }
    return sessions.get(sessionId) ?? null;
  };

  const recovery = createManagedGoalStaleRecovery({
    openCodeFetch,
    staleMs: STALE_MS,
    now: () => currentTime,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  await recovery.discoverNow();

  // First scan: tries to abort child (children first), no-op
  await recovery.scanNow();
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0], 'ses_child');
  assert.ok(warnings.some((w) => w[0].includes('abort did not settle')));

  // Child abort exhausted after 5 attempts
  for (let i = 0; i < 4; i += 1) {
    currentTime += 31 * 60 * 1_000; // Advance past max backoff
    await recovery.scanNow();
  }
  assert.equal(aborts.filter((a) => a === 'ses_child').length, 5);
  assert.ok(warnings.some((w) => w[0].includes('abort exhausted')));

  // Now child exhausted, but parent still has orphaned task pointing to unsettled child
  // taskPointsToTerminalChild returns false since child is not terminal
  // So parent's pending tool check prevents it from being a candidate
  // This is correct behavior: we cannot recover parent until child settles

  // Simulate child eventually settling (e.g., via external intervention)
  childMessage.info.error = { name: 'MessageAbortedError', message: 'Aborted' };
  childMessage.info.time.completed = currentTime;

  currentTime += 61_000;
  await recovery.scanNow();

  // Now parent should be recovered as orphaned task
  assert.ok(aborts.includes('ses_root'));
});
