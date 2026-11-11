import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useUpdateStore } from '@/stores/useUpdateStore';

let browser: Window;
let root: Root;
let previousGlobals: Map<string, PropertyDescriptor | undefined>;
const originalFetch = globalThis.fetch;
let requests: string[];
let respond: (path: string, method: string) => Promise<Response>;

const installation = (state: 'available' | 'downloading') => ({
  schemaVersion: 1,
  state,
  currentVersion: '2.0.0',
  targetVersion: '2.1.0',
  previousVersion: null,
  error: null,
  updatedAt: '2026-10-02T00:00:00.000Z',
});

beforeEach(async () => {
  browser = new Window({ url: 'http://localhost' });
  const globals = {
    window: browser, document: browser.document, navigator: browser.navigator,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    DocumentFragment: browser.DocumentFragment, MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previousGlobals = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, globals);
  useUpdateStore.getState().reset();
  requests = [];
  respond = async (path) => { throw new Error(`Unexpected request: ${path}`); };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${path}`);
    return respond(path, method);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUpdateStore.getState().reset();
  globalThis.fetch = originalFetch;
  browser.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const mount = async (packageManager: string) => {
  const { UpdateDialog } = await import('./UpdateDialog');
  await act(async () => root.render(
    <I18nProvider>
      <UpdateDialog open onOpenChange={() => undefined}
        info={{ available: true, currentVersion: '2.0.0', version: '2.1.0', packageManager }}
        downloading={false} downloaded={false} progress={null} error={null}
        onDownload={() => undefined} onRestart={() => undefined} runtimeType="web" />
    </I18nProvider>,
  ));
};

const clickUpdate = async () => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === 'Update Now');
  if (!button) throw new Error('Update Now is not rendered');
  await act(async () => button.click());
};

for (const clientRuntime of ['mobile', 'desktop'] as const) {
  test(`${clientRuntime} server dialog dispatches the explicit web target`, async () => {
    useUpdateStore.setState({ runtimeType: clientRuntime });
    respond = async (path, method) => {
      if (path === '/api/openchamber/update-status') return Response.json(installation('available'));
      if (path === '/api/openchamber/update-install' && method === 'POST') {
        return Response.json({ accepted: true, installation: installation('downloading') }, { status: 202 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    };
    await mount('validated-release');
    await clickUpdate();
    expect(requests).toContain('POST /api/openchamber/update-install');
    expect(useUpdateStore.getState().installation?.state).toBe('downloading');
    expect(useUpdateStore.getState().runtimeType).toBe(clientRuntime);
  });
}

test('native server dialog displays a managed installer rejection', async () => {
  useUpdateStore.setState({ runtimeType: 'mobile' });
  respond = async (path) => path.endsWith('update-status')
    ? Response.json(installation('available'))
    : Response.json({ error: 'Host owns this update' }, { status: 409 });
  await mount('validated-release');
  await clickUpdate();
  expect(document.body.textContent).toContain('Host owns this update');
});

test('Electron host success waits for the exact installed version, not availability', async () => {
  useUpdateStore.setState({ runtimeType: 'web' });
  let checks = 0;
  let finishTargetCheck = () => {};
  const targetChecked = new Promise<void>((resolve) => { finishTargetCheck = resolve; });
  respond = async (path) => {
    if (path.endsWith('update-install')) {
      return Response.json({ success: true, version: '2.1.0', updateOwner: 'electron-updater', autoRestart: true });
    }
    if (path === '/api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true') {
      checks += 1;
      if (checks === 2) finishTargetCheck();
      return Response.json({ available: false, currentVersion: checks === 1 ? '2.0.0' : '2.1.0' });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  await mount('electron');
  expect(requests).toEqual([]);
  await clickUpdate();
  expect(document.body.textContent).toContain('Server restarting...');
  expect(document.body.textContent).not.toContain('Server error: 200');
  await act(async () => {
    await targetChecked;
  });
  expect(checks).toBe(2);
  expect(document.body.textContent).toContain('Update installed');
  expect(requests.filter((request) => request.startsWith('POST'))).toHaveLength(1);
  expect(requests.some((request) => request.includes('update-status'))).toBe(false);
});

test('Electron host restart failure is shown and permits retry', async () => {
  useUpdateStore.setState({ runtimeType: 'mobile' });
  respond = async (path) => path.endsWith('update-install')
    ? Response.json({ success: true, version: '2.1.0', updateOwner: 'electron-updater', autoRestart: true })
    : Response.json({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'Signature rejected' }, { status: 503 });
  await mount('electron');
  await clickUpdate();
  expect(document.body.textContent).toContain('Signature rejected');
  await clickUpdate();
  expect(requests.filter((request) => request.startsWith('POST'))).toHaveLength(2);
  expect(requests.some((request) => request.includes('update-status'))).toBe(false);
});
