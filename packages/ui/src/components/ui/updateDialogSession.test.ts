import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { createUpdateDialogSession } from './updateDialogSession';
import { setUpdateStoreRuntimeFetchForTests, useUpdateStore } from '@/stores/useUpdateStore';
import type { WebUpdateInstallationStatus } from '@/components/update/web-update-status';
import { installWebUpdate, waitForUpdateApplied } from '@/lib/web-update';
import { deferredPoll } from '@/lib/timing/pollSubscription.test-support';

const messages = { failed: 'Update failed', takingLonger: 'Taking longer' };
const status = (state: WebUpdateInstallationStatus['state']): WebUpdateInstallationStatus => ({
  schemaVersion: 1, state, currentVersion: '1.0.0', targetVersion: '2.0.0-j2k.1',
  previousVersion: null, error: null, updatedAt: '2026-11-22T00:00:00Z',
});
const flush = async (ms = 0) => {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
beforeEach(() => {
  jest.useFakeTimers();
  useUpdateStore.getState().reset();
  setUpdateStoreRuntimeFetchForTests(async () => new Response('{}', { status: 503 }));
});
afterEach(() => {
  useUpdateStore.getState().reset();
  setUpdateStoreRuntimeFetchForTests(null);
  jest.useRealTimers();
});

test('opening refreshes authoritative state once; only an observed completion reloads', async () => {
  let requests = 0;
  let reloads = 0;
  setUpdateStoreRuntimeFetchForTests(async () => {
    requests += 1;
    return Response.json(status('installed'));
  });
  const session = createUpdateDialogSession({ open: true, web: true, electron: false, store: useUpdateStore, reload: () => { reloads += 1; } });
  const first = session.subscribe(() => {});
  const second = session.subscribe(() => {});
  await flush();
  expect(requests).toBe(1);
  expect(session.getSnapshot().phase).toBe('available');
  await flush(500);
  expect(reloads).toBe(0);
  useUpdateStore.getState().reconcileInstallation(status('restarting'));
  useUpdateStore.getState().reconcileInstallation(status('installed'));
  expect(session.getSnapshot().phase).toBe('installed');
  useUpdateStore.setState({ checking: true });
  await flush(500);
  expect(reloads).toBe(1);
  first();
  second();
});

test('unmount cancels reload and a closed dialog does not refresh', async () => {
  let requests = 0;
  let reloads = 0;
  setUpdateStoreRuntimeFetchForTests(async () => { requests += 1; return Response.json(status('installed')); });
  const session = createUpdateDialogSession({ open: false, web: true, electron: false, store: useUpdateStore, reload: () => { reloads += 1; } });
  const unsubscribe = session.subscribe(() => {});
  expect(requests).toBe(0);
  useUpdateStore.getState().reconcileInstallation(status('restarting'));
  useUpdateStore.getState().reconcileInstallation(status('installed'));
  unsubscribe();
  await flush(500);
  expect(reloads).toBe(0);
});

test('a renewed installed transition rearms reload after the previous completion was withdrawn', async () => {
  let reloads = 0;
  const session = createUpdateDialogSession({ open: false, web: true, electron: false, store: useUpdateStore, reload: () => { reloads += 1; } });
  const unsubscribe = session.subscribe(() => {});
  useUpdateStore.getState().reconcileInstallation(status('restarting'));
  useUpdateStore.getState().reconcileInstallation(status('installed'));
  useUpdateStore.getState().reconcileInstallation(status('restarting'));
  await flush(500);
  expect(reloads).toBe(0);
  useUpdateStore.getState().reconcileInstallation(status('installed'));
  await flush(499);
  expect(reloads).toBe(0);
  await flush(1);
  unsubscribe();
  expect(reloads).toBe(1);
});

test('the final unsubscribe stops Electron verification retries', async () => {
  let checks = 0;
  let finished = false;
  const session = createUpdateDialogSession({
    open: true, web: true, electron: true, store: useUpdateStore,
    reload: () => { throw new Error('must not reload'); },
    install: () => installWebUpdate(async () => Response.json({ success: true, updateOwner: 'electron-updater', version: '2.0.0' })),
    waitForApplied: (target, previous, options) => waitForUpdateApplied(target, previous, {
      ...options,
      fetchUpdate: async () => {
        checks += 1;
        return finished ? Response.json({ available: false, currentVersion: '2.0.0' }) : new Response('', { status: 503 });
      },
    }),
  });
  const unsubscribe = session.subscribe(() => {});
  const pending = session.start('1.0.0', messages);
  await flush();
  expect(checks).toBe(1);
  expect(jest.getTimerCount()).toBe(1);
  unsubscribe();
  expect(jest.getTimerCount()).toBe(0);
  try {
    await flush(2000);
    expect(checks).toBe(1);
    expect(session.getSnapshot().phase).toBe('restarting');
  } finally {
    finished = true;
    await flush(2000);
    await pending;
  }
});

test('the final unsubscribe aborts an in-flight verification request and its deadline', async () => {
  const signals: AbortSignal[] = [];
  const session = createUpdateDialogSession({
    open: true, web: true, electron: true, store: useUpdateStore,
    reload: () => { throw new Error('must not reload'); },
    install: () => installWebUpdate(async () => Response.json({ success: true, updateOwner: 'electron-updater', version: '2.0.0' })),
    waitForApplied: (target, previous, options) => waitForUpdateApplied(target, previous, {
      ...options,
      fetchUpdate: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Verification request has no cancellation signal');
        signals.push(signal);
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      }),
    }),
  });
  const first = session.subscribe(() => {});
  const last = session.subscribe(() => {});
  const pending = session.start('1.0.0', messages);
  await flush();
  expect(signals).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(1);
  first();
  expect(signals[0]?.aborted).toBe(false);
  last();
  expect(signals[0]?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  await pending;
  await flush(600000);
  expect(signals).toHaveLength(1);
  expect(session.getSnapshot().phase).toBe('restarting');
});

test('Electron host waits for its exact installed version before reloading', async () => {
  let reloads = 0;
  const fetched: string[] = [];
  const fetchUpdate = async (input: Parameters<typeof fetch>[0]) => {
    fetched.push(String(input));
    return String(input).includes('update-install')
      ? Response.json({ success: true, updateOwner: 'electron-updater', version: '2.0.0' })
      : Response.json({ available: false, currentVersion: '2.0.0' });
  };
  const session = createUpdateDialogSession({
    open: true, web: true, electron: true, store: useUpdateStore,
    reload: () => { reloads += 1; },
    install: () => installWebUpdate(fetchUpdate),
    waitForApplied: (target, previous) => waitForUpdateApplied(target, previous, { fetchUpdate }),
  });
  const unsubscribe = session.subscribe(() => {});
  await session.start('1.0.0', messages);
  expect(session.getSnapshot().phase).toBe('installed');
  expect(fetched).toEqual(['/api/openchamber/update-install', '/api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true']);
  expect(reloads).toBe(0);
  await flush(500);
  expect(reloads).toBe(1);
  unsubscribe();
});

test('Electron restart rejection stays visible and never reports installation', async () => {
  const session = createUpdateDialogSession({
    open: true, web: true, electron: true, store: useUpdateStore,
    reload: () => { throw new Error('must not reload'); },
    install: () => installWebUpdate(async () => Response.json({ success: true, updateOwner: 'electron-updater', version: '2.0.0' })),
    waitForApplied: (target, previous) => waitForUpdateApplied(target, previous, {
      fetchUpdate: async () => Response.json({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'Signature rejected' }, { status: 503 }),
    }),
  });
  const unsubscribe = session.subscribe(() => {});
  await session.start('1.0.0', messages);
  expect(session.getSnapshot()).toEqual({ phase: 'failed', error: 'Signature rejected' });
  await flush(500);
  unsubscribe();
});

test('a retired dialog cannot publish late Electron installation results', async () => {
  const response = deferredPoll<Response>();
  const session = createUpdateDialogSession({
    open: true, web: true, electron: true, store: useUpdateStore,
    reload: () => { throw new Error('must not reload'); },
    install: () => installWebUpdate(async () => response.promise),
  });
  const unsubscribe = session.subscribe(() => {});
  const pending = session.start('1.0.0', messages);
  unsubscribe();
  response.resolve(Response.json({ success: true, updateOwner: 'electron-updater', version: '2.0.0' }));
  await pending;
  expect(session.getSnapshot().phase).toBe('installing');
  await flush(1000);
});
