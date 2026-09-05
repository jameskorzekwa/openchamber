import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSnapshot,
  createOpmStatusPoller,
  isCommandAllowed,
  laneFor,
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

  it('keeps an item whose lifecycle effect is due on the board instead of dropping it between polls', () => {
    // OPM moves such an item into its fourth bucket, pendingOperations; the
    // dashboard read three and the row vanished until the effect was deferred
    // again (heirloom#856 flickered 5 <-> 3 on 2026-09-05).
    const snapshot = buildSnapshot({
      activity: {
        blockers: [entry({ ref: '820', phase: 'waiting_external', reason: 'waiting on 4/5 chunks' })],
        pendingOperations: [entry({
          ref: '856',
          phase: 'active',
          action: 'remediating',
          parentRef: '854',
          effect: { kind: 'session.wake', status: 'pending', attempts: 0, error: null },
          nextAction: 'session.wake is queued for the supervisor.',
        })],
      },
      status: { ok: true },
    });

    expect(snapshot.groups.active.map((row) => row.ref)).toEqual(['856']);
    expect(snapshot.groups.active[0]).toMatchObject({ activityState: 'pending', action: 'remediating' });
    expect(snapshot.counts).toEqual({ needsYou: 0, blocked: 0, active: 1, waiting: 1, queued: 0 });
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

  it('preserves owner questions and classifies them only as needs-you', () => {
    const question = {
      id: 'question-1',
      askedBy: 'worker',
      text: 'Which release path should I use?',
      options: [
        { key: 'A', label: 'Stable', detail: 'Use the stable channel', command: '/agent decide A' },
        { key: 'B', label: 'Preview', detail: 'Use the preview channel', command: '/agent decide B' },
      ],
      url: 'https://github.com/owner/openchamber/issues/12#issuecomment-1',
    };
    const snapshot = buildSnapshot({
      activity: {
        blockers: [entry({
          ref: '12',
          phase: 'waiting_external',
          needsOwnerDecision: true,
          question,
        })],
      },
      status: { ok: true },
    });

    expect(snapshot.counts).toEqual({ needsYou: 1, blocked: 0, active: 0, waiting: 0, queued: 0 });
    expect(snapshot.groups.needsYou[0]).toMatchObject({
      kind: 'owner-question',
      needsOwnerDecision: true,
      question,
      command: null,
      owner: { required: true },
    });
  });

  it('classifies waiting_owner decisions as needs-you with the supervisor command, not only legacy authorisation', () => {
    const snapshot = buildSnapshot({
      activity: {
        blockers: [entry({ ref: '115', phase: 'waiting_owner', action: 'waiting_owner', needsOwnerDecision: true, decisionCommand: '/agent decide <your decision and authorization>', reason: 'owner decision required: review rejected a641a8b8' })],
      },
      status: { ok: true, running: true },
    });
    expect(snapshot.groups.needsYou.map((row) => row.ref)).toEqual(['115']);
    expect(snapshot.groups.needsYou[0].kind).toBe('needs-owner');
    expect(snapshot.groups.needsYou[0].command).toBe('/agent decide <your decision and authorization>');
    expect(snapshot.groups.blocked).toEqual([]);
  });

  it('groups rows by project into owner lanes and passes through urls, alias, active time, completed', () => {
    const snapshot = buildSnapshot({
      activity: {
        blockers: [
          entry({ project: 'hh', projectName: 'Heirloom', alias: 'hh', ref: '1', phase: 'waiting_owner', action: 'waiting_owner', needsOwnerDecision: true, decisionCommand: '/agent decide A', url: 'https://x/1' }),
          entry({ project: 'hh', projectName: 'Heirloom', alias: 'hh', ref: '2', phase: 'waiting_external', action: 'waiting_external', reason: 'waiting for checks on abc', activeMs: 5000 }),
        ],
        active: [entry({ project: 'hh', projectName: 'Heirloom', alias: 'hh', ref: '3', phase: 'active', action: 'reviewing', sessionId: 'ses_1', activeMs: 100, activeSince: '2026-09-02T00:00:00Z' })],
        queued: [entry({ project: 'opm', projectName: 'OPM', alias: 'opm', ref: '4', phase: 'planned', action: 'queued', reason: 'queued: project is at its 1-worker limit' })],
        completed: [{ project: 'hh', projectName: 'Heirloom', alias: 'hh', ref: '9', title: 'Done', url: 'https://x/9', completedAt: '2026-09-02T00:00:00Z', activeMs: 42 }],
        completedTotal: 7,
      },
      status: { ok: true, running: true, projects: [
        { projectId: 'u1', project: 'hh', projectName: 'Heirloom' },
        { projectId: 'u2', project: 'opm', projectName: 'OPM' },
        { projectId: 'u3', project: 'ducks', projectName: 'QuickDucks' },
      ] },
      issueUrls: { opm: 'https://map/{ref}' },
    });
    expect(snapshot.byProject.map((group) => [group.project, group.counts])).toEqual([
      ['hh', { needsYou: 1, running: 1, waiting: 1, backlog: 0 }],
      ['opm', { needsYou: 0, running: 0, waiting: 0, backlog: 1 }],
      ['ducks', { needsYou: 0, running: 0, waiting: 0, backlog: 0 }],
    ]);
    expect(snapshot.byProject[0].items.map((item) => [item.ref, item.lane])).toEqual([['1', 'needsYou'], ['3', 'running'], ['2', 'waiting']]);
    expect(snapshot.byProject[0].items[0].url).toBe('https://x/1');
    expect(snapshot.byProject[0].items[1].activeSince).toBe('2026-09-02T00:00:00Z');
    expect(snapshot.byProject[0].items[2].activeMs).toBe(5000);
    expect(snapshot.byProject[1].items[0].url).toBe('https://map/4');
    expect(snapshot.completed).toEqual([{ project: 'hh', projectName: 'Heirloom', alias: 'hh', ref: '9', title: 'Done', url: 'https://x/9', completedAt: '2026-09-02T00:00:00Z', activeMs: 42 }]);
    expect(snapshot.completedTotal).toBe(7);
    expect(laneFor({ phase: 'active', action: 'active', sessionId: null, reason: null })).toBe('waiting');
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

  it('retains project labels and binds supervisor attention to its task', () => {
    const snapshot = buildSnapshot({
      activity: { blockers: [entry({ ref: '88', phase: 'blocked', reason: 'owner decision required' })] },
      status: {
        ok: false,
        projects: [{ projectId: 'project-uuid', project: 'openchamber', projectName: 'OpenChamber' }],
        attention: [{ kind: 'owner-decision', projectId: 'project-uuid', ref: '88', detail: 'review rejected' }],
      },
      issueUrls: { openchamber: 'https://github.com/owner/openchamber/issues/{ref}' },
    });

    expect(snapshot.supervisor.projects[0]).toMatchObject({
      projectId: 'project-uuid',
      project: 'openchamber',
      projectName: 'OpenChamber',
    });
    expect(snapshot.supervisor.attention[0]).toMatchObject({
      project: 'openchamber',
      projectName: 'OpenChamber',
      ref: '88',
      url: 'https://github.com/owner/openchamber/issues/88',
    });
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
