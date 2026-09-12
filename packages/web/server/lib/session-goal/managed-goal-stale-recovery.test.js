import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';

import { createManagedGoalStaleRecovery } from './managed-goal-stale-recovery.js';

const NOW = 2_000_000;
const STALE_MS = 100_000;
const OLD = NOW - STALE_MS - 1;
let stateDirectory;

beforeEach(async () => {
  stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'managed-goal-recovery-'));
});

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

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

const assistant = ({ id = 'msg_1', created = OLD, completed, error, parts = [] } = {}) => {
  const info = {
    id,
    role: 'assistant',
    sessionID: 'ses_root',
    providerID: 'provider',
    modelID: 'model',
    agent: 'build',
    time: { created },
  };
  if (completed) info.time.completed = completed;
  if (error) info.error = error;
  return { info, parts };
};

const createFixture = ({
  root = managedRoot(),
  child,
  rootMessage,
  childMessage,
  statuses = {},
  isEnabled,
  onAbort,
  patchFailures = 0,
  abortSettles = true,
  maxAbortAttempts,
  maxAutoTurns,
  maxDeliveryAttempts,
  now = () => NOW,
  promptAdmissionFailures = 0,
  promptPartialMessage = false,
  promptResponseFailure = false,
  deliveryBackoffMs,
} = {}) => {
  let currentStatuses = statuses;
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
  const prompts = [];

  const openCodeFetch = async (fetchPath, options = {}) => {
    if (fetchPath === '/experimental/session') return [...sessions.values()];
    if (fetchPath === '/session/status') return currentStatuses;
    const partMatch = fetchPath.match(/^\/session\/([^/]+)\/message\/([^/]+)\/part\/([^/]+)$/);
    if (partMatch && options.method === 'PATCH') {
      const sessionId = decodeURIComponent(partMatch[1]);
      const message = messages.get(sessionId);
      const index = message.parts.findIndex((part) => part.id === decodeURIComponent(partMatch[3]));
      if (index >= 0) message.parts[index] = options.body;
      return options.body;
    }
    const exactMessageMatch = fetchPath.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
    if (exactMessageMatch) return messages.get(decodeURIComponent(exactMessageMatch[1])) ?? null;
    const promptMatch = fetchPath.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (promptMatch) {
      const sessionId = decodeURIComponent(promptMatch[1]);
      prompts.push({ sessionId, body: options.body });
      if (promptAdmissionFailures > 0) {
        promptAdmissionFailures -= 1;
        throw new Error('prompt admission failed');
      }
      messages.set(sessionId, {
        info: { id: options.body.messageID, sessionID: sessionId, role: 'user', time: { created: NOW } },
        parts: promptPartialMessage ? [] : options.body.parts,
      });
      if (promptResponseFailure) throw new Error('response lost after prompt admission');
      return null;
    }
    const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message|abort))?$/);
    if (!match) throw new Error(`unexpected path ${fetchPath}`);
    const sessionId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';
    if (suffix === 'children') return children.get(sessionId) ?? [];
    if (suffix === 'message') return messages.has(sessionId) ? [messages.get(sessionId)] : [];
    if (suffix === 'abort') {
      aborts.push(sessionId);
      const message = messages.get(sessionId);
      if (message && abortSettles) {
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
  const recoveryOptions = {
    openCodeFetch,
    staleMs: STALE_MS,
    now,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
    stateDirectory,
  };
  if (isEnabled) recoveryOptions.isEnabled = isEnabled;
  if (maxAbortAttempts) recoveryOptions.maxAbortAttempts = maxAbortAttempts;
  if (maxAutoTurns) recoveryOptions.maxAutoTurns = maxAutoTurns;
  if (maxDeliveryAttempts) recoveryOptions.maxDeliveryAttempts = maxDeliveryAttempts;
  if (deliveryBackoffMs !== undefined) recoveryOptions.deliveryBackoffMs = deliveryBackoffMs;
  const recovery = createManagedGoalStaleRecovery(recoveryOptions);

  return {
    aborts,
    messages,
    openCodeFetch,
    patches,
    prompts,
    recovery,
    root,
    sessions,
    setStatuses: (next) => { currentStatuses = next; },
    warnings,
  };
};

test('does not recover an unbound stale child stream omitted from session status', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const fixture = createFixture({ child, childMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, []);
  assert.equal(fixture.patches.length, 0);
});

test('recovers the stale child before its orphaned foreground task parent', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootMessage = assistant({
    parts: [{
      id: 'call_task1',
      messageID: 'msg_1',
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
  assert.equal(fixture.patches.length, 2);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
  assert.equal(fixture.root.metadata.openchamber.goal.turnsUsed, 8);
});

test('recovers a stale direct parent stream and resumes the same goal', async () => {
  const fixture = createFixture({ rootMessage: assistant(), statuses: {} });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.patches.length, 2);
  assert.equal(fixture.root.metadata.openchamber.goal.id, 'goal_1');
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
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
  assert.equal(fixture.patches.length, 2);
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
});

test('no-op abort does not log recovered and backs off retries', async () => {
  let currentTime = NOW;
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
    stateDirectory,
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

test('recovery process restart preserves retry state and deadline', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    abortSettles: false,
    now: () => currentTime,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  assert.equal(fixture.aborts.length, 1);
  fixture.recovery.stop();

  const restarted = createManagedGoalStaleRecovery({
    openCodeFetch: fixture.openCodeFetch,
    staleMs: STALE_MS,
    now: () => currentTime,
    sleep: async () => {},
    logger: { warn: () => {} },
    stateDirectory,
  });

  await restarted.discoverNow();
  await restarted.scanNow();
  assert.equal(fixture.aborts.length, 1);

  currentTime += 61_000;
  await restarted.scanNow();
  assert.equal(fixture.aborts.length, 2);
});

for (const damagedState of [
  { name: 'malformed', create: (target) => writeFile(target, '{not json') },
  { name: 'unsupported-version', create: (target) => writeFile(target, JSON.stringify({ version: 2 })) },
  { name: 'unreadable', create: (target) => mkdir(target) },
]) {
  test(`fails closed without resetting abort attempts for ${damagedState.name} recovery state`, async () => {
    const fixture = createFixture({
      rootMessage: assistant({ id: 'msg_stale' }),
      abortSettles: false,
    });
    const target = path.join(stateDirectory, 'ses_root.goal-recovery.json');
    await damagedState.create(target);

    await fixture.recovery.discoverNow();
    await fixture.recovery.scanNow();

    assert.deepEqual(fixture.aborts, []);
    assert.ok(fixture.warnings.some((warning) => warning[0].includes('invalid recovery state preserved')));
  });
}

test('process restart reconciles a response-lost continuation without sending it twice', async () => {
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
    promptResponseFailure: true,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.equal(fixture.aborts.length, 1);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.root.metadata.openchamber.goal.statusReason, /^stale-recovery:/);
  fixture.recovery.stop();

  const warnings = [];
  const restarted = createManagedGoalStaleRecovery({
    openCodeFetch: fixture.openCodeFetch,
    staleMs: STALE_MS,
    stateDirectory,
    sleep: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });
  await restarted.discoverNow();
  await restarted.scanNow();

  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
  assert.ok(warnings.some((warning) => warning[0].includes('verified continuation')));
});

test('blocks recovery instead of exceeding the auto-continuation cap', async () => {
  const root = managedRoot();
  root.metadata.openchamber.goal.turnsUsed = 20;
  const fixture = createFixture({
    root,
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
    maxAutoTurns: 20,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.equal(fixture.prompts.length, 0);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'blocked');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'auto-continuation limit reached');
  assert.equal(fixture.root.metadata.openchamber.goal.turnsUsed, 20);
});

test('budget-limits recovery instead of exceeding the token budget', async () => {
  const root = managedRoot();
  root.metadata.openchamber.goal.tokensUsed = 500;
  root.metadata.openchamber.goal.tokenBudget = 500;
  const fixture = createFixture({
    root,
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.equal(fixture.prompts.length, 0);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'budgetLimited');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'token budget reached');
});

test('delivery exhaustion visibly blocks the goal and clears its recovery hold', async () => {
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
    maxDeliveryAttempts: 2,
    deliveryBackoffMs: 0,
    promptAdmissionFailures: 2,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  await fixture.recovery.scanNow();
  await fixture.recovery.scanNow();

  assert.equal(fixture.prompts.length, 2);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'blocked');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'stale recovery continuation delivery exhausted');
  await fixture.recovery.scanNow();
  assert.equal(fixture.prompts.length, 2);
});

test('process restart durably bounds reconciliation of an incomplete recovery message', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
    maxDeliveryAttempts: 3,
    deliveryBackoffMs: 100,
    promptPartialMessage: true,
    now: () => currentTime,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  await fixture.recovery.scanNow();
  currentTime += 101;
  await fixture.recovery.scanNow();
  fixture.recovery.stop();

  const restarted = createManagedGoalStaleRecovery({
    openCodeFetch: fixture.openCodeFetch,
    staleMs: STALE_MS,
    maxAbortAttempts: 1,
    maxDeliveryAttempts: 3,
    deliveryBackoffMs: 100,
    now: () => currentTime,
    stateDirectory,
    sleep: async () => {},
    logger: { warn: () => {} },
  });
  await restarted.discoverNow();
  await restarted.scanNow();

  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  currentTime += 201;
  await restarted.scanNow();
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'blocked');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, 'stale recovery continuation message remained incomplete');
  await restarted.scanNow();
  assert.equal(fixture.prompts.length, 1);
});

test('process restart continues an abort attempt persisted before settlement verification', async () => {
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    statuses: {},
    abortSettles: false,
  });
  let abortReturned = false;
  let verificationFailed = false;
  const interruptedFetch = async (fetchPath, options) => {
    const result = await fixture.openCodeFetch(fetchPath, options);
    if (fetchPath.endsWith('/abort')) abortReturned = true;
    if (abortReturned && !verificationFailed && fetchPath.endsWith('/message')) {
      verificationFailed = true;
      throw new Error('process stopped before settlement verification');
    }
    return result;
  };
  const first = createManagedGoalStaleRecovery({
    openCodeFetch: interruptedFetch,
    staleMs: STALE_MS,
    maxAbortAttempts: 1,
    stateDirectory,
    sleep: async () => {},
    logger: { warn: () => {} },
  });
  await first.discoverNow();
  await first.scanNow();
  assert.equal(fixture.aborts.length, 1);
  assert.equal(fixture.prompts.length, 0);
  first.stop();

  const restarted = createManagedGoalStaleRecovery({
    openCodeFetch: fixture.openCodeFetch,
    staleMs: STALE_MS,
    maxAbortAttempts: 1,
    stateDirectory,
    sleep: async () => {},
    logger: { warn: () => {} },
  });
  await restarted.discoverNow();
  await restarted.scanNow();
  assert.equal(fixture.aborts.length, 1);
  assert.equal(fixture.prompts.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
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
  assert.equal(fixture.patches.length, 2);
  assert.equal(fixture.root.metadata.openchamber.goal.status, 'active');
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
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
  const fixture = createFixture({
    rootMessage: assistant({ id: 'msg_stale' }),
    abortSettles: false,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  assert.equal(fixture.aborts.length, 1);

  fixture.messages.set('ses_root', {
    info: { id: 'msg_new', role: 'user', time: { created: NOW } },
    parts: [],
  });

  await fixture.recovery.scanNow();
  assert.equal(fixture.aborts.length, 1);
});

test('respects replaced goal by not recovering old goal sessions', async () => {
  let currentTime = NOW;
  const root = managedRoot();
  const fixture = createFixture({
    root,
    rootMessage: assistant(),
    statuses: {},
    abortSettles: false,
    now: () => currentTime,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  assert.equal(fixture.aborts.length, 1);
  root.metadata.openchamber.goal.id = 'goal_replaced';
  currentTime += 61_000;
  await fixture.recovery.scanNow();

  assert.equal(fixture.aborts.length, 1);
  assert.equal(fixture.root.metadata.openchamber.goal.id, 'goal_replaced');
});

test('explicit pause cancels a durable retry without another abort', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant(),
    statuses: {},
    abortSettles: false,
    now: () => currentTime,
  });
  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  fixture.root.metadata.openchamber.goal.status = 'paused';
  fixture.root.metadata.openchamber.goal.statusReason = 'paused by user';
  currentTime += 61_000;
  await fixture.recovery.scanNow();
  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.prompts.length, 0);
});

test('workspace transition cancels a durable retry', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant(),
    statuses: {},
    abortSettles: false,
    now: () => currentTime,
  });
  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  fixture.root.directory = '/different-worktree';
  currentTime += 61_000;
  await fixture.recovery.scanNow();
  assert.deepEqual(fixture.aborts, ['ses_root']);
  assert.equal(fixture.prompts.length, 0);
});

test('unavailable status preserves the durable retry instead of resetting attempts', async () => {
  let currentTime = NOW;
  const fixture = createFixture({
    rootMessage: assistant(),
    statuses: {},
    abortSettles: false,
    now: () => currentTime,
  });
  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();
  fixture.setStatuses(null);
  currentTime += 61_000;
  await fixture.recovery.scanNow();
  assert.deepEqual(fixture.aborts, ['ses_root']);
  fixture.setStatuses({});
  await fixture.recovery.scanNow();
  assert.deepEqual(fixture.aborts, ['ses_root', 'ses_root']);
});

test('no-op child abort reconciles the exact task and sends one verified continuation', async () => {
  const child = { id: 'ses_child', parentID: 'ses_root', directory: '/worktree', time: { updated: OLD } };
  const rootMessage = assistant({
    id: 'msg_parent',
    parts: [{
      id: 'call_task1',
      messageID: 'msg_parent',
      sessionID: 'ses_root',
      type: 'tool',
      tool: 'task',
      callID: 'task-call-1',
      state: { status: 'running', metadata: { sessionId: child.id } },
    }],
  });
  const childMessage = assistant({ id: 'msg_child' });
  const fixture = createFixture({
    child,
    childMessage,
    rootMessage,
    statuses: {},
    abortSettles: false,
    maxAbortAttempts: 1,
  });

  await fixture.recovery.discoverNow();
  await fixture.recovery.scanNow();

  assert.deepEqual(fixture.aborts, ['ses_child']);
  assert.equal(childMessage.info.error, undefined);
  assert.equal(childMessage.info.time.completed, undefined);
  assert.equal(rootMessage.parts[0].state.status, 'error');
  assert.equal(rootMessage.parts[0].state.metadata.interrupted, true);
  assert.match(rootMessage.parts[0].state.error, /outcome is unknown/);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0].body.messageID, /^msg_recovery_/);
  assert.equal(fixture.root.metadata.openchamber.goal.turnsUsed, 8);
  assert.equal(fixture.root.metadata.openchamber.goal.statusReason, '');
  assert.ok(fixture.warnings.some((warning) => warning[0].includes('verified continuation')));

  fixture.recovery.stop();
  const restarted = createManagedGoalStaleRecovery({
    openCodeFetch: async (fetchPath, options) => {
      if (fetchPath === '/experimental/session') return [...fixture.sessions.values()];
      if (fetchPath === '/session/status') return {};
      const match = fetchPath.match(/^\/session\/([^/]+)(?:\/(children|message))?$/);
      if (!match) throw new Error(`unexpected restart request ${fetchPath}`);
      const sessionId = decodeURIComponent(match[1]);
      if (match[2] === 'children') return sessionId === 'ses_root' ? [child] : [];
      if (match[2] === 'message') return [fixture.messages.get(sessionId)];
      return fixture.sessions.get(sessionId);
    },
    staleMs: STALE_MS,
    stateDirectory,
    sleep: async () => {},
    logger: { warn: () => {} },
  });
  await restarted.discoverNow();
  await restarted.scanNow();
  assert.equal(fixture.prompts.length, 1);
});
