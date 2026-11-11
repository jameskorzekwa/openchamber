import { describe, expect, test } from 'bun:test';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2';

import { areRunningSubtaskListsEqual, listRunningSubtasks } from './runningSubtasks';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory: '/repo',
  title: `Title ${id}`,
  version: '1',
  time: { created: 1, updated: 1 },
  ...overrides,
});

const busy: SessionStatus = { type: 'busy' };
const idle: SessionStatus = { type: 'idle' };
const retry: SessionStatus = { type: 'retry', attempt: 1, message: 'rate limited', next: 2 };

describe('listRunningSubtasks', () => {
  test('returns nothing without a parent', () => {
    expect(listRunningSubtasks([session('child', { parentID: 'parent' })], { child: busy }, null)).toEqual([]);
    expect(listRunningSubtasks([session('child', { parentID: 'parent' })], { child: busy }, '')).toEqual([]);
  });

  test('keeps only busy or retrying children of the parent, oldest first', () => {
    const sessions = [
      session('newer', { parentID: 'parent', time: { created: 300, updated: 300 } }),
      session('older', { parentID: 'parent', time: { created: 100, updated: 400 } }),
      session('retrying', { parentID: 'parent', time: { created: 200, updated: 200 } }),
      session('finished', { parentID: 'parent', time: { created: 50, updated: 50 } }),
      session('unknown', { parentID: 'parent', time: { created: 60, updated: 60 } }),
      session('other-parent', { parentID: 'someone-else', time: { created: 10, updated: 10 } }),
      session('parent'),
    ];
    const statuses = { newer: busy, older: busy, retrying: retry, finished: idle, 'other-parent': busy, parent: busy };

    expect(listRunningSubtasks(sessions, statuses, 'parent')).toEqual([
      { id: 'older', title: 'Title older', startedAt: 100 },
      { id: 'retrying', title: 'Title retrying', startedAt: 200 },
      { id: 'newer', title: 'Title newer', startedAt: 300 },
    ]);
  });

  test('reports a blank title as missing so the caller can label it', () => {
    const [subtask] = listRunningSubtasks([session('child', { parentID: 'parent', title: '   ' })], { child: busy }, 'parent');
    expect(subtask.title).toBeNull();
  });
});

describe('areRunningSubtaskListsEqual', () => {
  test('compares by identity, title, and start time', () => {
    const base = listRunningSubtasks([session('child', { parentID: 'parent' })], { child: busy }, 'parent');
    const same = listRunningSubtasks([session('child', { parentID: 'parent' })], { child: busy }, 'parent');
    const renamed = listRunningSubtasks([session('child', { parentID: 'parent', title: 'Renamed' })], { child: busy }, 'parent');

    expect(areRunningSubtaskListsEqual(base, same)).toBe(true);
    expect(areRunningSubtaskListsEqual(base, renamed)).toBe(false);
    expect(areRunningSubtaskListsEqual(base, [])).toBe(false);
  });
});
