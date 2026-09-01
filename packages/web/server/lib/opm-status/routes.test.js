import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSnapshot,
  createOpmStatusPoller,
  isCommandAllowed,
  ownerGuidance,
  registerOpmStatusRoutes,
  resolveRepo,
} from './routes.js';

const SHA = 'a'.repeat(40);
const entry = (overrides = {}) => ({
  project: 'openchamber',
  projectName: 'OpenChamber',
  ref: '100',
  title: 'Port OPM status',
  phase: 'active',
  state: 'implemented',
  action: 'active',
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
    expect(snapshot.groups.active[0]).toMatchObject({ state: 'implemented', action: 'active' });
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
            { ref: '21', title: 'Rich child', phase: 'waiting_external', state: 'implemented', action: 'reviewing', activityState: 'stopped', reason: 'waiting for checks' },
            { ref: '22', title: 'Inline child', phase: 'planned', state: 'planned', action: 'queued', activityState: 'queued', reason: null },
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
    expect(snapshot.tree[0].childRows[1]).toMatchObject({ state: 'planned', action: 'queued', owner: expect.any(Object) });
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

  it('notifies on every successful snapshot, skips failures, and survives notifier errors', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('pushover exploded'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ active: [entry()] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValue(new Response('down', { status: 503 }));
    const poller = createOpmStatusPoller({ controlUrl: 'http://127.0.0.1:47651', issueUrls: {}, now: () => 123, notifier: { notify } });

    await expect(poller.poll()).resolves.toMatchObject({ available: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ available: true }));

    await expect(poller.poll()).resolves.toMatchObject({ available: false });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sets no-store and clears polling through an idempotent close handle', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const handlers = new Map();
    const poller = { poll: vi.fn(), current: () => ({ available: true }) };
    const runtime = registerOpmStatusRoutes({
      get: (route, handler) => handlers.set(route, handler),
      post: () => {},
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

describe('OPM command endpoint', () => {
  const AUTHORIZE = `/agent authorize ${SHA}`;

  const commandSnapshot = () => buildSnapshot({
    activity: {
      blockers: [entry({ ref: '10', phase: 'blocked', reason: `needs owner authorisation; comment "${AUTHORIZE}"` })],
      active: [entry({ ref: '20', phase: 'active' })],
    },
    status: { ok: true, attention: [{ kind: 'stalled_dispatch', ref: '77', detail: 'no progress' }] },
  });

  const register = ({ snapshot = commandSnapshot(), config, execFile } = {}) => {
    const posted = new Map();
    const poller = { poll: vi.fn(), current: () => snapshot };
    const runtime = registerOpmStatusRoutes({
      get: () => {},
      post: (route, ...handlers) => posted.set(route, handlers.at(-1)),
    }, {
      poller,
      config: config ?? { controlUrl: 'http://127.0.0.1:47651', issueUrls: {}, repos: { openchamber: 'owner/name' } },
      execFile,
    });
    poller.poll.mockClear();
    return { handler: posted.get('/api/opm/command'), poller, runtime };
  };

  const createRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
  };

  it('executes a valid needs-owner command through gh with exact args and polls immediately', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '', ''));
    const { handler, poller, runtime } = register({ execFile });
    const res = createRes();

    await handler({ body: { project: 'openchamber', ref: '10', command: AUTHORIZE } }, res);

    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'comment', '10', '--repo', 'owner/name', '--body', AUTHORIZE],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(poller.poll).toHaveBeenCalledTimes(1);
    runtime.close();
  });

  it('rejects a mismatched command with 400 and never executes anything', async () => {
    const execFile = vi.fn();
    const { handler, poller, runtime } = register({ execFile });
    const res = createRes();

    await handler({ body: { project: 'openchamber', ref: '10', command: `/agent authorize ${'b'.repeat(40)}` } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: expect.stringContaining('does not match') });
    expect(execFile).not.toHaveBeenCalled();
    expect(poller.poll).not.toHaveBeenCalled();
    runtime.close();
  });

  it('allows "/agent resume" for non-terminal rows and stalled attention refs, not for terminal rows', async () => {
    const snapshot = commandSnapshot();
    expect(isCommandAllowed(snapshot, { project: 'openchamber', ref: '20', command: '/agent resume' })).toBe(true);
    expect(isCommandAllowed(snapshot, { project: 'openchamber', ref: '77', command: '/agent resume' })).toBe(true);
    expect(isCommandAllowed(snapshot, { project: 'openchamber', ref: '999', command: '/agent resume' })).toBe(false);
    const terminal = buildSnapshot({
      activity: { active: [entry({ ref: '30', phase: 'completed' })] },
      status: { ok: true },
    });
    expect(isCommandAllowed(terminal, { project: 'openchamber', ref: '30', command: '/agent resume' })).toBe(false);
    expect(isCommandAllowed({ available: false }, { project: 'openchamber', ref: '20', command: '/agent resume' })).toBe(false);

    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '', ''));
    const { handler, runtime } = register({ execFile });
    const res = createRes();
    await handler({ body: { project: 'openchamber', ref: '20', command: '/agent resume' } }, res);
    expect(res.body).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'comment', '20', '--repo', 'owner/name', '--body', '/agent resume'],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
    runtime.close();
  });

  it('resolves the repo from the repos map first and the issueUrls template as fallback', async () => {
    const config = {
      controlUrl: 'http://127.0.0.1:47651',
      issueUrls: { openchamber: 'https://github.com/fallback-owner/fallback-repo/issues/{ref}' },
      repos: {},
    };
    expect(resolveRepo({ repos: { openchamber: 'owner/name' }, issueUrls: config.issueUrls }, 'openchamber')).toBe('owner/name');
    expect(resolveRepo(config, 'openchamber')).toBe('fallback-owner/fallback-repo');
    expect(resolveRepo({ repos: {}, issueUrls: {} }, 'openchamber')).toBeNull();

    const execFile = vi.fn((_command, _args, _options, callback) => callback(null, '', ''));
    const { handler, runtime } = register({ config, execFile });
    const res = createRes();
    await handler({ body: { project: 'openchamber', ref: '10', command: AUTHORIZE } }, res);
    expect(execFile).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'fallback-owner/fallback-repo']),
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
    runtime.close();
  });

  it('reports a missing repo mapping as 400 and a gh failure as 502 with the error', async () => {
    const unmapped = register({
      config: { controlUrl: 'http://127.0.0.1:47651', issueUrls: {}, repos: {} },
      execFile: vi.fn(),
    });
    const missingRes = createRes();
    await unmapped.handler({ body: { project: 'openchamber', ref: '10', command: AUTHORIZE } }, missingRes);
    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.body).toMatchObject({ ok: false, error: expect.stringContaining('No GitHub repository') });
    unmapped.runtime.close();

    const failing = register({
      execFile: vi.fn((_command, _args, _options, callback) => callback(new Error('spawn gh ENOENT'), '', '')),
    });
    const failRes = createRes();
    await failing.handler({ body: { project: 'openchamber', ref: '10', command: AUTHORIZE } }, failRes);
    expect(failRes.statusCode).toBe(502);
    expect(failRes.body).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') });
    expect(failing.poller.poll).not.toHaveBeenCalled();
    failing.runtime.close();
  });
});
