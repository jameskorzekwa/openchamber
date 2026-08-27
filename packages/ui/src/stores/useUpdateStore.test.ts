import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  setUpdateStoreRuntimeFetchForTests,
  useUpdateStore,
} from './useUpdateStore';

const status = (state: 'available' | 'downloading' | 'installing' | 'restarting' | 'installed' | 'failed' | 'rollback' | 'no-validated-release') => ({
  schemaVersion: 1 as const,
  state,
  currentVersion: '1.0.0',
  targetVersion: '2.0.0-j2k.1',
  previousVersion: null,
  error: state === 'failed' ? 'failed' : null,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

beforeEach(() => {
  useUpdateStore.getState().reset();
  useUpdateStore.setState({ runtimeType: 'web' });
});

afterEach(() => {
  useUpdateStore.getState().reset();
  setUpdateStoreRuntimeFetchForTests(null);
});

describe('web installation lifecycle recovery', () => {
  test('hydrates an active server lifecycle and prevents a second install', async () => {
    const requests: string[] = [];
    setUpdateStoreRuntimeFetchForTests(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify(status('restarting')), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await useUpdateStore.getState().refreshInstallation();
    expect(useUpdateStore.getState().installation?.state).toBe('restarting');
    expect(await useUpdateStore.getState().startWebUpdate()).toBe(false);
    expect(requests).toEqual(['/api/openchamber/update-status']);
  });

  test('reopening or a fresh tab recovers the authoritative state again', async () => {
    let lifecycle = status('installing');
    setUpdateStoreRuntimeFetchForTests(async () => new Response(JSON.stringify(lifecycle), { status: 200 }));
    await useUpdateStore.getState().refreshInstallation();
    expect(useUpdateStore.getState().installation?.state).toBe('installing');

    useUpdateStore.getState().reset();
    useUpdateStore.setState({ runtimeType: 'web' });
    lifecycle = status('rollback');
    await useUpdateStore.getState().refreshInstallation();
    expect(useUpdateStore.getState().installation?.state).toBe('rollback');
  });

  test('retains the accepted POST lifecycle instead of inventing success', async () => {
    let posts = 0;
    setUpdateStoreRuntimeFetchForTests(async (_input, init) => {
      if (init?.method === 'POST') posts += 1;
      return new Response(JSON.stringify({ accepted: true, installation: status('downloading') }), { status: 202 });
    });
    expect(await useUpdateStore.getState().startWebUpdate()).toBe(true);
    expect(useUpdateStore.getState().installation?.state).toBe('downloading');
    expect(posts).toBe(1);
  });
});
