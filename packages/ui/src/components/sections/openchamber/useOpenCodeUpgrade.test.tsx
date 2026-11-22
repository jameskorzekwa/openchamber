import React, { act } from 'react';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useOpenCodeUpgrade } from './useOpenCodeUpgrade';

let dom: Window;
let root: Root;
let upgrade: ReturnType<typeof useOpenCodeUpgrade>;
let currentVersion: string;
let statusFails: boolean;
let installError: string | null;
let restoreFetch: () => void;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

function Probe() {
  upgrade = useOpenCodeUpgrade('Upgrade failed');
  return <div>{upgrade.phase.kind}</div>;
}

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  currentVersion = '2.3.1';
  statusFails = false;
  installError = null;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/opencode/upgrade-status') {
      return statusFails
        ? new Response(null, { status: 503 })
        : Response.json({ currentVersion, latestVersion: '2.3.2', available: true, upgrade: { supported: true } });
    }
    if (url.pathname === '/api/opencode/upgrade') {
      return installError
        ? Response.json({ success: false, error: installError }, { status: 500 })
        : Response.json({ success: true, version: 'v2.3.2' });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  restoreFetch = () => fetchSpy.mockRestore();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  dom.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

test('installed status clears only when the server reports the installed version running', async () => {
  expect(upgrade.status?.currentVersion).toBe('2.3.1');
  await act(async () => upgrade.upgrade());
  expect(upgrade.phase).toEqual({ kind: 'installed', version: 'v2.3.2' });
  await act(async () => upgrade.reloadAfterUpgrade(async () => {}));
  expect(upgrade.phase.kind).toBe('installed');
  currentVersion = '2.3.2';
  await act(async () => upgrade.reloadAfterUpgrade(async () => {}));
  expect(upgrade.phase.kind).toBe('idle');
  expect(upgrade.status?.currentVersion).toBe('2.3.2');
});

test('a failed refresh keeps prior status and cannot clear the installed version', async () => {
  await act(async () => upgrade.upgrade());
  statusFails = true;
  await act(async () => upgrade.reloadAfterUpgrade(async () => { throw new Error('Reload failed'); }));
  expect(upgrade.phase).toEqual({ kind: 'installed', version: 'v2.3.2' });
  expect(upgrade.status?.currentVersion).toBe('2.3.1');
});

test('a rejected installation exposes the server error and can be retried', async () => {
  installError = 'Installation unavailable';
  await act(async () => upgrade.upgrade());
  expect(upgrade.phase).toEqual({ kind: 'failed', error: 'Installation unavailable' });
  installError = null;
  await act(async () => upgrade.upgrade());
  expect(upgrade.phase).toEqual({ kind: 'installed', version: 'v2.3.2' });
});
