import { describe, expect, test } from 'bun:test';

import { getOpmCounts, ownerGuidanceKind, parseOpmSnapshot } from './opm-status';

const row = (overrides = {}) => ({
  project: 'openchamber', projectName: 'OpenChamber', ref: '1', title: 'Work', phase: 'active', activityState: 'working',
  parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: null, nextAction: null, updatedAt: null,
  effect: null, children: [], kind: null, command: null, owner: { required: false, instruction: 'Nothing needed.' }, url: null,
  ...overrides,
});

const snapshot = (workRow = row()) => ({
  available: true as const,
  fetchedAt: 100,
  state: 'active',
  summary: 'Working',
  healthOk: true,
  paused: false,
  counts: { needsYou: 99, blocked: 99, active: 99, waiting: 99, queued: 99 },
  groups: { needsYou: [], blocked: [], active: [workRow], waiting: [], queued: [] },
  tree: [{ ...workRow, childRows: [] }],
  supervisor: { running: true, pausedReason: null, startedAt: null, lastPollAt: null, pollIntervalMs: null, counters: {}, attention: [], projects: [] },
});

describe('OPM status parser', () => {
  test('accepts a complete snapshot and derives honest counts from groups', () => {
    const parsed = parseOpmSnapshot(snapshot());
    expect(parsed.available).toBe(true);
    if (!parsed.available) throw new Error('expected available snapshot');
    expect(getOpmCounts(parsed)).toEqual({ needsYou: 0, blocked: 0, active: 1, waiting: 0, queued: 0 });
  });

  test('rejects malformed rows instead of rendering partial network data', () => {
    expect(() => parseOpmSnapshot(snapshot(row({ owner: undefined })))).toThrow();
  });

  test('keeps unavailable distinct from successful empty work', () => {
    expect(parseOpmSnapshot({ available: false, fetchedAt: 100, error: 'down' })).toEqual({ available: false, fetchedAt: 100, error: 'down' });
  });

  test('classifies localized owner guidance without trusting English server copy', () => {
    expect(ownerGuidanceKind(row({ phase: 'blocked', kind: 'needs-owner' }))).toBe('authorize');
    expect(ownerGuidanceKind(row({ phase: 'blocked', kind: 'dead-letter' }))).toBe('deadLetter');
    expect(ownerGuidanceKind(row({ phase: 'waiting_external', reason: 'waiting for checks on abc' }))).toBe('checks');
    expect(ownerGuidanceKind(row({ phase: 'waiting_external', nextAction: 'Wait' }))).toBe('nextAction');
  });
});
