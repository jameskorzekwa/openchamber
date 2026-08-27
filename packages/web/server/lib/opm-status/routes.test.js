import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSnapshot,
  createOpmStatusPoller,
  ownerGuidance,
  registerOpmStatusRoutes,
} from './routes.js';

const SHA = 'a'.repeat(40);
const entry = (overrides = {}) => ({
  project: 'openchamber',
  projectName: 'OpenChamber',
  ref: '100',
  title: 'Port OPM status',
  phase: 'active',
  updatedAt: '2026-08-26T12:00:00.000Z',
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OPM owner guidance and classification', () => {
  it('answers owner action for normal, authorization, paused, and waiting states', () => {
    expect(ownerGuidance({ phase: 'active', ref: '1' })).toMatchObject({ required: false });
    expect(ownerGuidance({ needsOwner: true, ref: '2' })).toEqual({
      required: true,
      instruction: 'Post this comment on issue #2 to approve the protected change:',
    });
    expect(ownerGuidance({ phase: 'paused', ref: '3' })).toMatchObject({ required: true });
    expect(ownerGuidance({ phase: 'waiting_external', reason: 'waiting for checks on abc', ref: '4' }))
      .toMatchObject({ required: false, instruction: expect.stringContaining('CI is running') });
  });

  it('classifies every activity family from the row phase rather than its source array', () => {
    const snapshot = buildSnapshot({
      activity: {
        active: [
          entry({ ref: '1', phase: 'active' }),
          entry({ ref: '2', phase: 'waiting_external', reason: 'waiting on 1/2 chunks' }),
        ],
        blockers: [entry({ ref: '3', phase: 'blocked', reason: 'dependency unavailable' })],
        queued: [entry({ ref: '4', phase: 'active', reason: 'queued: project is at its worker limit' })],
      },
      status: { ok: true },
    });

    expect(snapshot.counts).toEqual({ needsYou: 0, blocked: 1, active: 1, waiting: 1, queued: 1 });
    expect(snapshot.groups.active.map((row) => row.ref)).toEqual(['1']);
    expect(snapshot.groups.waiting.map((row) => row.ref)).toEqual(['2']);
    expect(snapshot.groups.queued.map((row) => row.ref)).toEqual(['4']);
  });

  it('promotes authorization and dead-letter rows into needs-you with exact commands', () => {
    const snapshot = buildSnapshot({
      activity: {
        blockers: [
          entry({ ref: '10', phase: 'blocked', reason: `needs owner authorisation; comment "/agent authorize ${SHA}"` }),
          entry({ ref: '11', phase: 'blocked', reason: 'effect session.create exhausted its retries' }),
        ],
      },
      status: { ok: false },
    });

    expect(snapshot.groups.needsYou).toHaveLength(2);
    expect(snapshot.groups.needsYou[0]).toMatchObject({ kind: 'needs-owner', command: `/agent authorize ${SHA}`, owner: { required: true } });
    expect(snapshot.groups.needsYou[1]).toMatchObject({ kind: 'dead-letter', command: '/agent resume', owner: { required: true } });
  });

  it('builds one parent-child tree, synthesizes missing children, and keeps rich rows', () => {
    const snapshot = buildSnapshot({
      activity: {
        blockers: [entry({
          ref: '20',
          phase: 'waiting_external',
          reason: 'waiting on 2/3 chunks',
          children: [
            { ref: '21', title: 'Rich child', phase: 'waiting_external', activityState: 'stopped', reason: 'waiting for checks' },
            { ref: '22', title: 'Inline child', phase: 'planned', activityState: 'queued', reason: null },
          ],
        })],
        active: [entry({ ref: '21', parentRef: '20', sessionId: 'ses_21', workspacePath: '/repo/worktree' })],
      },
      status: { ok: true },
    });

    expect(snapshot.tree).toHaveLength(1);
    expect(snapshot.tree[0].ref).toBe('20');
    expect(snapshot.tree[0].childRows.map((row) => row.ref)).toEqual(['21', '22']);
    expect(snapshot.tree[0].childRows[0]).toMatchObject({ sessionId: 'ses_21', workspacePath: '/repo/worktree' });
    expect(snapshot.tree[0].childRows[1].owner).toBeDefined();
  });

  it('raises a family containing an owner-required child above active roots', () => {
    const snapshot = buildSnapshot({
      activity: {
        active: [entry({ ref: '30', phase: 'active' })],
        blockers: [
          entry({ ref: '40', phase: 'waiting_external', reason: 'waiting on 1/2 chunks' }),
          entry({ ref: '41', parentRef: '40', phase: 'blocked', reason: `needs owner authorisation; comment "/agent authorize ${SHA}"` }),
        ],
      },
      status: { ok: false },
    });

    expect(snapshot.tree.map((row) => row.ref)).toEqual(['40', '30']);
    expect(snapshot.tree[0].childRows[0].ref).toBe('41');
  });
});

describe('OPM polling and route lifecycle', () => {
  it('publishes unavailable rather than an empty success when either upstream request fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ active: [entry()] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('down', { status: 503 }));
    const poller = createOpmStatusPoller({ controlUrl: 'http://127.0.0.1:47651', issueUrls: {}, now: () => 123 });

    await expect(poller.poll()).resolves.toMatchObject({
      available: false,
      fetchedAt: 123,
      error: expect.stringContaining('returned 503'),
    });
    expect(poller.current()).not.toHaveProperty('groups');
  });

  it('sets no-store and clears polling through an idempotent close handle', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const handlers = new Map();
    const poller = { poll: vi.fn(), current: () => ({ available: true }) };
    const runtime = registerOpmStatusRoutes({
      get: (route, handler) => handlers.set(route, handler),
    }, { poller });
    const response = { set: vi.fn(), json: vi.fn() };

    handlers.get('/api/opm/status')({}, response);
    expect(response.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.json).toHaveBeenCalledWith({ available: true });

    runtime.close();
    runtime.close();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
