import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const createManagedStateDirectory = async ({ phase = 'attached', managedGoal = goal } = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-goal-runtime-'));
  await writeFile(path.join(directory, `${SESSION_ID}.json`), JSON.stringify({
    version: 1,
    sessionID: SESSION_ID,
    managedGoalID: managedGoal.id,
    managedGoal,
    managedGoalObjective: managedGoal.objective,
    phase,
  }));
  return directory;
};

const managedGoal = (overrides = {}) => ({
  ...goal,
  managedWorktree: true,
  ...overrides,
});

const assistantMessages = [{
  info: {
    id: 'msg_assistant',
    sessionID: SESSION_ID,
    role: 'assistant',
    providerID: 'provider',
    modelID: 'model',
    time: { completed: 2 },
    tokens: { input: 1, output: 1, cache: { read: 0 } },
  },
  parts: [{ type: 'text', text: 'All requested work is verified complete.' }],
}];

const startIdleTick = async (fetchImpl) => {
  const getSmallModelService = vi.fn();
  vi.stubGlobal('fetch', vi.fn((input, init) => (
    requestPath(input) === '/experimental/session'
      ? jsonResponse([])
      : fetchImpl(input, init)
  )));
  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    isEnabled: () => true,
    idleQuietMs: 10,
  });
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.advanceTimersByTimeAsync(10);
  return { runtime, getSmallModelService };
};

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('retries the quiet window when live status cannot be read', async () => {
    const paths = [];
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ error: 'unavailable' }, 503);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}`,
      '/session/status',
    ]);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === '/experimental/session') return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([{
          info: {
            id: 'msg_assistant',
            sessionID: SESSION_ID,
            role: 'assistant',
            providerID: 'provider',
            modelID: 'model',
            time: { completed: 2 },
            tokens: { input: 1, output: 1, cache: { read: 0 } },
          },
          parts: [{ type: 'text', text: 'The task is verified complete.' }],
        }]);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Task verified complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    vi.stubGlobal('fetch', fetchImpl);
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(service.generateSmallModelText).toHaveBeenCalledOnce();
    const patch = requests.find((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
    expect(patch).toBeDefined();
    const writtenGoal = JSON.parse(patch.body).metadata.openchamber.goal;
    expect(writtenGoal).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    runtime.stop();
  });

  it('preserves managedWorktree metadata and holds ticks during worktree movement', async () => {
    const paths = [];
    const heldSession = {
      ...session,
      metadata: {
        openchamber: {
          goal: {
            ...goal,
            managedWorktree: true,
            statusReason: 'worktree-moving',
          },
        },
      },
    };
    const { runtime, getSmallModelService } = await startIdleTick(vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(heldSession);
      throw new Error(`Unexpected request: ${pathname}`);
    }));

    expect(paths).toEqual([`/session/${SESSION_ID}`]);
    expect(getSmallModelService).not.toHaveBeenCalled();
    runtime.stop();
  });
});

describe('managed worktree goal runtime integration', () => {
  const stateDirectories = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const directory of stateDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const createRuntime = ({ fetchImpl, stateDirectory, service }) => {
    vi.stubGlobal('fetch', vi.fn((input, init) => (
      requestPath(input) === '/experimental/session'
        ? jsonResponse([])
        : fetchImpl(input, init)
    )));
    return createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
      managedWorktreeStateDirectory: stateDirectory,
    });
  };

  it('rejects an audit completion until the managed lifecycle gate is complete', async () => {
    const activeGoal = managedGoal();
    const stateDirectory = await createManagedStateDirectory({ managedGoal: activeGoal });
    stateDirectories.push(stateDirectory);
    let liveSession = { ...session, metadata: { openchamber: { goal: activeGoal } } };
    const requests = [];
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"complete","note":"Everything is complete"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    const runtime = createRuntime({
      stateDirectory,
      service,
      fetchImpl: vi.fn(async (input, init = {}) => {
        const pathname = requestPath(input);
        requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
        if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
          liveSession = { ...liveSession, metadata: JSON.parse(init.body).metadata };
          return jsonResponse(liveSession);
        }
        if (pathname === `/session/${SESSION_ID}`) return jsonResponse(liveSession);
        if (pathname === '/session/status') return jsonResponse({});
        if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
        if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse(assistantMessages);
        if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({ ok: true });
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    });

    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => {
      expect(requests.some((request) => request.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(true);
    });

    expect(liveSession.metadata.openchamber.goal).toMatchObject({
      status: 'active',
      turnsUsed: 2,
      note: 'Finish implementation and provide verified dev deployment evidence before returning to the primary workspace.',
    });
    runtime.stop();
  });

  it('restores the protected managed goal identity after a clearing event', async () => {
    const protectedGoal = managedGoal({ turnsUsed: 4, note: 'Progress retained' });
    const stateDirectory = await createManagedStateDirectory({ managedGoal: protectedGoal });
    stateDirectories.push(stateDirectory);
    let liveSession = { ...session, metadata: { openchamber: {} } };
    const patches = [];
    const runtime = createRuntime({
      stateDirectory,
      service: null,
      fetchImpl: vi.fn(async (input, init = {}) => {
        const pathname = requestPath(input);
        if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') {
          const body = JSON.parse(init.body);
          patches.push(body);
          liveSession = { ...liveSession, metadata: body.metadata };
          return jsonResponse(liveSession);
        }
        if (pathname === `/session/${SESSION_ID}`) return jsonResponse(liveSession);
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: { info: liveSession },
    });
    await vi.waitFor(() => expect(patches).toHaveLength(1));

    expect(liveSession.metadata.openchamber.goal).toMatchObject({
      id: protectedGoal.id,
      managedWorktree: true,
      status: 'active',
      statusReason: 'resumed',
      turnsUsed: 4,
    });
    runtime.stop();
  });

  it('persists managed progress from a session.updated event', async () => {
    const progressGoal = managedGoal({ turnsUsed: 7, tokensUsed: 123, note: 'Tests running' });
    const stateDirectory = await createManagedStateDirectory({ phase: 'goal-completion-pending', managedGoal: progressGoal });
    stateDirectories.push(stateDirectory);
    const runtime = createRuntime({
      stateDirectory,
      service: null,
      fetchImpl: vi.fn(async (input) => {
        throw new Error(`Unexpected request: ${requestPath(input)}`);
      }),
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: { ...session, metadata: { openchamber: { goal: progressGoal } } },
      },
    });
    const progressPath = path.join(stateDirectory, `${SESSION_ID}.goal.json`);
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(progressPath, 'utf8'))).toMatchObject({
        id: progressGoal.id,
        turnsUsed: 7,
        tokensUsed: 123,
        note: 'Tests running',
      });
    });
    runtime.stop();
  });

  it('holds worktree-resume-dispatching updates without scheduling a tick', async () => {
    const heldGoal = managedGoal({ turnsUsed: 0, statusReason: 'worktree-resume-dispatching' });
    const stateDirectory = await createManagedStateDirectory({ phase: 'moving-to-worktree', managedGoal: heldGoal });
    stateDirectories.push(stateDirectory);
    const requestPaths = [];
    const runtime = createRuntime({
      stateDirectory,
      service: null,
      fetchImpl: vi.fn(async (input) => {
        requestPaths.push(requestPath(input));
        throw new Error(`Unexpected request: ${requestPath(input)}`);
      }),
    });

    runtime.processPayload({
      type: 'session.updated',
      properties: {
        info: { ...session, metadata: { openchamber: { goal: heldGoal } } },
      },
    });
    const progressPath = path.join(stateDirectory, `${SESSION_ID}.goal.json`);
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(progressPath, 'utf8')).statusReason).toBe('worktree-resume-dispatching');
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(requestPaths).toEqual([]);
    runtime.stop();
  });
});
