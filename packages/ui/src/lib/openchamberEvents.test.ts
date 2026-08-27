import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { shouldReloadForBuildRevision } from './buildRevision';

declare global {
  var __BUILD_REVISION__: string | undefined;
}

mock.module('./runtime-url', () => ({
  getRuntimeUrlResolver: () => ({ sse: (path: string) => `http://runtime.test${path}` }),
}));

let runtimeEndpointChanged: (() => void) | null = null;

mock.module('./runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChanged = listener;
    return () => {
      runtimeEndpointChanged = null;
    };
  },
}));

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('openchamber events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    runtimeEndpointChanged = null;
    globalThis.window = {} as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    globalThis.__BUILD_REVISION__ = 'client-revision';
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    delete globalThis.__BUILD_REVISION__;
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const unsubscribe = subscribeOpenchamberEvents(listener);
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });

    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });

  test('reloads exactly once when ready reports a different build across reconnects', async () => {
    const values = new Map<string, string>();
    let reloadCount = 0;
    const reload = () => {
      reloadCount += 1;
    };
    Object.assign(globalThis.window, {
      location: { reload },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    const source = MockEventSource.instances[0];
    const ready = JSON.stringify({
      type: 'openchamber:event-stream-ready',
      properties: { buildRevision: 'server-revision' },
    });

    source.onmessage?.({ data: ready });
    runtimeEndpointChanged?.();
    MockEventSource.instances[1].onmessage?.({ data: ready });

    expect(reloadCount).toBe(1);
    unsubscribe();
  });

  test('does not reload when session storage rejects the guard write', async () => {
    let reloadCount = 0;
    const reload = () => {
      reloadCount += 1;
    };
    Object.assign(globalThis.window, {
      location: { reload },
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage unavailable');
        },
      },
    });
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    const source = MockEventSource.instances[0];
    const ready = JSON.stringify({
      type: 'openchamber:event-stream-ready',
      properties: { buildRevision: 'server-revision' },
    });

    source.onmessage?.({ data: ready });
    source.onmessage?.({ data: ready });

    expect(reloadCount).toBe(0);
    unsubscribe();
  });
});

describe('build revision reload guard', () => {
  test('reloads once for a different server revision', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(shouldReloadForBuildRevision('1.22.0-j2k.1', '1.21.0-j2k.1', storage)).toBe(true);
    expect(shouldReloadForBuildRevision('1.22.0-j2k.1', '1.21.0-j2k.1', storage)).toBe(false);
  });

  test('does not reload matching or missing revisions', () => {
    const storage = { getItem: () => null, setItem: () => undefined };

    expect(shouldReloadForBuildRevision('1.21.0', '1.21.0', storage)).toBe(false);
    expect(shouldReloadForBuildRevision('', '1.21.0', storage)).toBe(false);
    expect(shouldReloadForBuildRevision('1.21.0', '', storage)).toBe(false);
    expect(shouldReloadForBuildRevision('../unsafe', '1.21.0', storage)).toBe(false);
  });
});
