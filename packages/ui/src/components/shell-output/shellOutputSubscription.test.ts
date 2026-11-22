import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { createShellOutputSubscription } from './shellOutputSubscription';
import type { ShellOutputEvent } from './shellOutputState';
import { deferredPoll } from '@/lib/timing/pollSubscription.test-support';

const flush = async (ms = 0) => {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

type TestShellPresence = { running: boolean; ended: Extract<ShellOutputEvent, { t: 'ended' }> | null };

function fixture(read: Parameters<typeof createShellOutputSubscription>[0]['read']) {
  const listeners = new Set<() => void>();
  let presence: TestShellPresence = { running: true, ended: null };
  const store = createShellOutputSubscription({
    read,
    isNotFound: (error) => error instanceof Error && error.message === 'not found',
    getPresence: () => presence,
    subscribePresence: (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    omittedLabel: 'Earlier output omitted',
  });
  return {
    store,
    listeners,
    end: () => {
      presence = { running: false, ended: { t: 'ended', status: 'exited', exit: 0 } };
      listeners.forEach((notify) => notify());
    },
  };
}

test('subscribers share one cursor and drain the final output after exit', async () => {
  const cursors: Array<number | undefined> = [];
  const pages = [
    { output: 'partial\nfirst\n', cursor: 20, skipped: true },
    { output: 'last\n', cursor: 25 },
    { output: '', cursor: 25 },
  ];
  const { store, end, listeners } = fixture(async (cursor) => {
    cursors.push(cursor);
    const page = pages.shift();
    if (!page) throw new Error('unexpected read');
    return page;
  });
  expect(cursors).toEqual([]);
  const first = store.subscribe(() => {});
  const second = store.subscribe(() => {});
  await flush();
  expect(store.getSnapshot().chunks.map((chunk) => chunk.data).join('')).toBe('Earlier output omitted\r\nfirst\r\n');
  const snapshot = store.getSnapshot();
  listeners.forEach((notify) => notify());
  expect(store.getSnapshot()).toBe(snapshot);
  end();
  await flush(1000);
  expect(store.getSnapshot().state).toEqual({ kind: 'ended', status: 'exited', exit: 0 });
  expect(store.getSnapshot().chunks.at(-1)?.data).toBe('last\r\n');
  await flush(1000);
  await flush(10000);
  expect(cursors).toEqual([undefined, 20, 25]);
  first();
  expect(listeners.size).toBe(1);
  second();
  expect(listeners.size).toBe(0);
});

test('quiet reads back off and unsubscribing rejects in-flight pages', async () => {
  let reads = 0;
  const page = deferredPoll<{ output: string; cursor: number }>();
  const { store } = fixture(async () => {
    reads += 1;
    return reads === 4 ? page.promise : { output: '', cursor: 0 };
  });
  const unsubscribe = store.subscribe(() => {});
  await flush();
  await flush(1000);
  await flush(1999);
  expect(reads).toBe(2);
  await flush(1);
  await flush(3999);
  expect(reads).toBe(3);
  await flush(1);
  expect(reads).toBe(4);
  unsubscribe();
  page.resolve({ output: 'stale', cursor: 5 });
  await flush();
  expect(store.getSnapshot().chunks).toEqual([]);
  await flush(10000);
  expect(reads).toBe(4);
});

test('opening an ended shell preserves its terminal status through the first page', async () => {
  const { store, end } = fixture(async () => ({ output: 'done\n', cursor: 5 }));
  end();
  const unsubscribe = store.subscribe(() => {});
  await flush();
  expect(store.getSnapshot().state).toEqual({ kind: 'ended', status: 'exited', exit: 0 });
  unsubscribe();
});

test('an evicted command retains previously read output and stops reading', async () => {
  let reads = 0;
  const { store } = fixture(async () => {
    if (++reads > 1) throw new Error('not found');
    return { output: 'kept\n', cursor: 5 };
  });
  const unsubscribe = store.subscribe(() => {});
  await flush();
  await flush(1000);
  expect(store.getSnapshot().state).toEqual({ kind: 'ended', status: 'unknown' });
  expect(store.getSnapshot().chunks[0]?.data).toBe('kept\r\n');
  await flush(10000);
  expect(reads).toBe(2);
  unsubscribe();
});
