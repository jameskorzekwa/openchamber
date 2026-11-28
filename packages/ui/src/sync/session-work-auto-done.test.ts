import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { setSessionParentResolver } from './global-session-status';
import { buildInWorkAutoDoneCandidates } from './session-work-auto-done';

const DAY_MS = 86_400_000;
const NOW = 1_750_000_000_000;

const makeSession = (
  id: string,
  overrides: {
    parentID?: string;
    time?: Session['time'];
    openedAt?: number;
    workState?: 'open' | 'done';
  } = {},
): Session => {
  const { openedAt, workState = 'open', time, parentID } = overrides;
  return {
    id,
    projectID: 'proj-1',
    directory: '/repo',
    title: id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    parentID,
    time: time ?? { created: NOW - 10 * DAY_MS, updated: NOW - 10 * DAY_MS, idle: NOW - 10 * DAY_MS },
    metadata: workState ? { openchamber: { work: { state: workState, openedAt: openedAt ?? NOW - 10 * DAY_MS, openedBy: 'auto' } } } : undefined,
  };
};

describe('buildInWorkAutoDoneCandidates', () => {
  test('selects only inactive top-level unarchived in-work sessions older than the cutoff', () => {
    const stale = makeSession('stale');
    const recent = makeSession('recent', { time: { created: NOW - 10 * DAY_MS, updated: NOW - 2 * DAY_MS, idle: NOW - 2 * DAY_MS } });
    const recentlyTracked = makeSession('recently-tracked', { openedAt: NOW - 1 * DAY_MS });
    const alreadyDone = makeSession('already-done', { workState: 'done' });
    const current = makeSession('current');
    const running = makeSession('running');
    const blocked = makeSession('blocked');
    const pinned = makeSession('pinned');
    const archived = makeSession('archived', { time: { created: NOW - 10 * DAY_MS, updated: NOW - 10 * DAY_MS, archived: NOW - 1 * DAY_MS } });
    const child = makeSession('child', { parentID: 'stale' });

    const candidates = buildInWorkAutoDoneCandidates({
      sessions: [stale, recent, recentlyTracked, alreadyDone, current, running, blocked, pinned, archived, child],
      currentSessionId: 'current',
      autoDoneDays: 7,
      activeSessionIds: new Set(['running']),
      blockingSessionIds: new Set(['blocked']),
      isPinned: (session) => session.id === 'pinned',
      now: NOW,
    });

    expect(candidates.map((session) => session.id)).toEqual(['stale']);
  });

  test('returns nothing when autoDoneDays is 0', () => {
    const stale = makeSession('stale');
    expect(buildInWorkAutoDoneCandidates({
      sessions: [stale],
      currentSessionId: null,
      autoDoneDays: 0,
      activeSessionIds: new Set(),
      blockingSessionIds: new Set(),
      now: NOW,
    })).toEqual([]);
  });

  test('protects a root session when a descendant is running, waiting, or currently open', () => {
    const parentRunning = makeSession('parent-running');
    const parentWaiting = makeSession('parent-waiting');
    const parentOpen = makeSession('parent-open');
    const stale = makeSession('stale');
    setSessionParentResolver((id) => {
      if (id === 'child-running') return 'parent-running';
      if (id === 'child-waiting') return 'parent-waiting';
      if (id === 'child-open') return 'parent-open';
      return undefined;
    });
    try {
      const candidates = buildInWorkAutoDoneCandidates({
        sessions: [parentRunning, parentWaiting, parentOpen, stale],
        currentSessionId: 'child-open',
        autoDoneDays: 7,
        activeSessionIds: new Set(['child-running']),
        blockingSessionIds: new Set(['child-waiting']),
        now: NOW,
      });
      expect(candidates.map((session) => session.id)).toEqual(['stale']);
    } finally {
      setSessionParentResolver(() => undefined);
    }
  });
});
