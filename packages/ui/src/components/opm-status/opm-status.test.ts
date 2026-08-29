import { describe, expect, test } from 'bun:test';

import { getOpmCounts, getSalientOpmCount, ownerGuidanceKind, parseOpmSnapshot } from './opm-status';

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

  test('preserves arbitrary parent and child depth at the network boundary', () => {
    const level4 = { ...row({ ref: '4', parentRef: '3' }), childRows: [] };
    const level3 = { ...row({ ref: '3', parentRef: '2' }), childRows: [level4] };
    const level2 = { ...row({ ref: '2', parentRef: '1' }), childRows: [level3] };
    const parsed = parseOpmSnapshot({ ...snapshot(), tree: [{ ...row(), childRows: [level2] }] });
    if (!parsed.available) throw new Error('expected available snapshot');
    expect(parsed.tree[0].childRows[0].childRows[0].childRows[0].ref).toBe('4');
  });

  test('rejects malformed rows instead of rendering partial network data', () => {
    expect(() => parseOpmSnapshot(snapshot(row({ owner: undefined })))).toThrow();
  });

  test('keeps unavailable distinct from successful empty work', () => {
    expect(parseOpmSnapshot({ available: false, fetchedAt: 100, error: 'down' })).toEqual({ available: false, fetchedAt: 100, error: 'down' });
  });

  test('selects the salient mobile count by priority, shows zero for idle, and none when unavailable', () => {
    const withGroups = (groups: Record<string, unknown[]>) => {
      const parsed = parseOpmSnapshot({ ...snapshot(), groups: { needsYou: [], blocked: [], active: [], waiting: [], queued: [], ...groups } });
      return getSalientOpmCount(parsed);
    };
    expect(withGroups({ needsYou: [row({ kind: 'needs-owner' }), row({ ref: '2', kind: 'needs-owner' })], active: [row()] })).toBe('2');
    expect(withGroups({ blocked: [row({ phase: 'blocked' })], active: [row()], waiting: [row({ ref: '3' })] })).toBe('1');
    expect(withGroups({ active: [row(), row({ ref: '2' })], waiting: [row({ ref: '3' })] })).toBe('2');
    expect(withGroups({ waiting: [row({ phase: 'waiting_external' })] })).toBe('1');
    expect(withGroups({ queued: [row({ phase: 'planned' }), row({ ref: '2', phase: 'planned' }), row({ ref: '3', phase: 'planned' })] })).toBe('3');
    expect(withGroups({})).toBe('0');
    expect(getSalientOpmCount({ available: false, fetchedAt: 100, error: 'down' })).toBeNull();
  });

  test('classifies localized owner guidance without trusting English server copy', () => {
    expect(ownerGuidanceKind(row({ phase: 'blocked', kind: 'needs-owner' }))).toBe('authorize');
    expect(ownerGuidanceKind(row({ phase: 'blocked', kind: 'dead-letter' }))).toBe('deadLetter');
    expect(ownerGuidanceKind(row({ phase: 'waiting_external', reason: 'waiting for checks on abc' }))).toBe('checks');
    expect(ownerGuidanceKind(row({ phase: 'waiting_external', nextAction: 'Wait' }))).toBe('nextAction');
  });
});
