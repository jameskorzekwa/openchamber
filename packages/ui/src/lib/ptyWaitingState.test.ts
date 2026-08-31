import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { formatPtyWaitingElapsed, getPtyWaitingState } from './ptyWaitingState';

type JobFixture = {
  id?: string;
  kind?: string;
  createdAt?: number;
  description?: string;
} | null;

const baseSession = (): Session => ({
  id: 'ses_waiting',
  slug: 'waiting',
  projectID: 'project',
  directory: '/repo',
  title: 'Waiting session',
  version: '1',
  time: { created: 1, updated: 1 },
});

const sessionWithJobs = (jobs: JobFixture[] | string): Session => Object.assign(baseSession(), {
  metadata: {
    openchamber: {
      backgroundJobs: { jobs },
    },
  },
});

describe('getPtyWaitingState', () => {
  test('fails closed for missing and malformed metadata', () => {
    expect(getPtyWaitingState(null)).toEqual({ count: 0, oldestCreatedAt: null, description: null });
    expect(getPtyWaitingState(baseSession())).toEqual({ count: 0, oldestCreatedAt: null, description: null });
    expect(getPtyWaitingState(sessionWithJobs('not-an-array'))).toEqual({ count: 0, oldestCreatedAt: null, description: null });
  });

  test('accepts only complete PTY jobs', () => {
    const state = getPtyWaitingState(sessionWithJobs([
      { id: 'pty_valid', kind: 'pty', createdAt: 200, description: '  Wait for deploy  ' },
      { id: 'shell_other', kind: 'shell', createdAt: 100, description: 'Ignore this' },
      { id: '', kind: 'pty', createdAt: 50 },
      { id: 'pty_no_time', kind: 'pty' },
      null,
    ]));

    expect(state).toEqual({ count: 1, oldestCreatedAt: 200, description: 'Wait for deploy' });
  });

  test('counts PTY jobs, keeps the oldest timestamp, and generalizes multiple descriptions', () => {
    const state = getPtyWaitingState(sessionWithJobs([
      { id: 'pty_newer', kind: 'pty', createdAt: 900, description: 'Newer process' },
      { id: 'pty_oldest', kind: 'pty', createdAt: 300, description: 'Older process' },
      { id: 'pty_middle', kind: 'pty', createdAt: 600 },
    ]));

    expect(state).toEqual({ count: 3, oldestCreatedAt: 300, description: null });
  });

  test('uses no description for a blank single-job description', () => {
    expect(getPtyWaitingState(sessionWithJobs([
      { id: 'pty_blank', kind: 'pty', createdAt: 100, description: '   ' },
    ]))).toEqual({ count: 1, oldestCreatedAt: 100, description: null });
  });
});

describe('formatPtyWaitingElapsed', () => {
  test('formats under one hour as mm:ss', () => {
    expect(formatPtyWaitingElapsed(-1)).toBe('00:00');
    expect(formatPtyWaitingElapsed(5.9)).toBe('00:05');
    expect(formatPtyWaitingElapsed(3599)).toBe('59:59');
  });

  test('formats one hour and above as h:mm:ss', () => {
    expect(formatPtyWaitingElapsed(3600)).toBe('1:00:00');
    expect(formatPtyWaitingElapsed(36_661)).toBe('10:11:01');
  });
});
