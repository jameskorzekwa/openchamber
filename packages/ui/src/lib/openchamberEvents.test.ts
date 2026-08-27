import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { shouldReloadForBuildRevision } from './buildRevision';

declare global {
  var __BUILD_REVISION__: string | undefined;
}

// The real runtime-switch fans endpoint changes out through this window event.
const RUNTIME_ENDPOINT_CHANGED_EVENT = 'openchamber:runtime-endpoint-changed';

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
    Object.defineProperty(globalThis, 'window', {
      value: Object.assign(new EventTarget(), { location: new URL('http://runtime.test') }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true });
    globalThis.__BUILD_REVISION__ = 'client-revision';
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'EventSource');
    delete globalThis.__BUILD_REVISION__;
  });

  test('does not open the server-only event stream in VS Code', async () => {
    Object.defineProperty(window, '__VSCODE_CONFIG__', {
      value: { workspaceFolder: 'C:/repo', workspaceFolders: [] },
      configurable: true,
    });
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => undefined);
    try {
      expect(MockEventSource.instances).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
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

  test('a connected control SSE stream clears delivered queues without reconnecting or polling', async () => {
    const { subscribeMessageQueueSync } = await import('@/sync/message-queue-sync');
    const { getRuntimeKey } = await import('./runtime-switch');
    const { useMessageQueueStore, createMessageQueueTarget, getMessageQueueKey } = await import('@/stores/messageQueueStore');
    const runtimeKey = getRuntimeKey();
    const target = createMessageQueueTarget('session-sse', '/repo', runtimeKey);
    if (!target) throw new Error('Missing queue target');
    useMessageQueueStore.getState().resetForRuntimeSwitch(runtimeKey);
    useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
    const originalFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
      if (url.pathname === '/api/message-queue') reads += 1;
      return Response.json({ revision: 1, sessions: [] });
    }, originalFetch);
    const unsubscribe = subscribeMessageQueueSync(runtimeKey);
    const source = MockEventSource.instances[0];
    try {
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:event-stream-ready', properties: {} }) });
      await useMessageQueueStore.getState().hydrate();
      expect(reads).toBe(1);
      const session = { sessionId: target.sessionId, directory: target.directory, sendingId: 'q1', items: [{ id: 'q1', content: 'queued', text: 'queued', createdAt: 1, attachments: [], sendConfig: { providerID: 'p', modelID: 'm' } }] };
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 2, session } }) });
      const key = getMessageQueueKey(target);
      expect(useMessageQueueStore.getState().queuedMessages[key]).toHaveLength(1);
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 3, session: { ...session, items: [], sendingId: null } } }) });
      expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined();
      expect(useMessageQueueStore.getState().sendingIds[key]).toBeUndefined();
      expect(reads).toBe(1);
      expect(MockEventSource.instances).toHaveLength(1);
      unsubscribe();
      source.onmessage?.({ data: JSON.stringify({ type: 'openchamber:message-queue.updated', properties: { revision: 4, session } }) });
      expect(useMessageQueueStore.getState().queuedMessages[key]).toBeUndefined();
    } finally {
      unsubscribe();
      globalThis.fetch = originalFetch;
    }
  });

  test('dispatches worktree topology changes', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:worktree-changed',
        properties: { directories: ['/repo', '/repo-linked'], at: 456 },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:worktree-changed',
        properties: { directories: [], at: 789 },
      }),
    });

    expect(events).toEqual([
      { type: 'worktree-changed', directories: ['/repo', '/repo-linked'], changedAt: 456 },
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
    window.dispatchEvent(new CustomEvent(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail: { apiBaseUrl: 'http://runtime.test', previousApiBaseUrl: 'http://runtime.test', runtimeKey: 'local', previousRuntimeKey: 'local' },
    }));
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
