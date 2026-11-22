import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { createInstallationMonitor } from './installationMonitor';
import type { WebUpdateInstallationStatus } from '@/components/update/web-update-status';
import { deferredPoll } from '@/lib/timing/pollSubscription.test-support';

const status = (state: WebUpdateInstallationStatus['state']): WebUpdateInstallationStatus => ({
  schemaVersion: 1, state, currentVersion: '1.0.0', targetVersion: '2.0.0-j2k.1',
  previousVersion: null, error: null, updatedAt: '2026-11-22T00:00:00Z',
});
const flush = async (ms = 0) => {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function fixture(read: Parameters<typeof createInstallationMonitor>[0]['read']) {
  let current: WebUpdateInstallationStatus | null = null;
  const monitor = createInstallationMonitor({
    read,
    current: () => current,
    publish: (next) => { current = next; monitor.observe(next); },
  });
  return { monitor, current: () => current, observe: (next: WebUpdateInstallationStatus) => { current = next; monitor.observe(next); } };
}

test('reconnect failures preserve the lifecycle and continue polling until terminal', async () => {
  let reads = 0;
  const { monitor, current, observe } = fixture(async () => {
    reads += 1;
    if (reads === 1) return null;
    if (reads === 2) throw new Error('restarting');
    return status('installed');
  });
  observe(status('restarting'));
  await flush(2000);
  expect(current()?.state).toBe('restarting');
  await flush(2000);
  expect(current()?.state).toBe('restarting');
  await flush(2000);
  expect(current()?.state).toBe('installed');
  await flush(20000);
  expect(reads).toBe(3);
  monitor.reset();
});

test('concurrent refreshes share a read and newer lifecycle changes reject its response', async () => {
  const response = deferredPoll<WebUpdateInstallationStatus>();
  let reads = 0;
  const { monitor, current, observe } = fixture(async () => { reads += 1; return response.promise; });
  observe(status('installing'));
  const first = monitor.refresh();
  const second = monitor.refresh();
  expect(reads).toBe(1);
  observe(status('rollback'));
  response.resolve(status('installed'));
  expect((await first)?.state).toBe('rollback');
  expect(await second).toBe(current());
  await flush(10000);
  expect(reads).toBe(1);
  monitor.reset();
});

test('reset aborts an outstanding request and cannot publish its old-runtime response', async () => {
  const response = deferredPoll<WebUpdateInstallationStatus>();
  let requestSignal: AbortSignal | undefined;
  const { monitor, current } = fixture(async (signal) => { requestSignal = signal; return response.promise; });
  const pending = monitor.refresh();
  monitor.reset();
  expect(requestSignal?.aborted).toBe(true);
  response.resolve(status('restarting'));
  await pending;
  expect(current()).toBeNull();
  await flush(10000);
  expect(current()).toBeNull();
});
