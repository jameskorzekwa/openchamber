import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session, SessionStatus } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useUIStore } from '@/stores/useUIStore';

let BackgroundWorkBanner: typeof import('./BackgroundWorkBanner').BackgroundWorkBanner;

const directory = '/background-work-test';
const parentId = 'parent-session';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'project',
  directory,
  title: `Title ${id}`,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: Date.now() - 65_000, updated: Date.now() },
  ...overrides,
});

describe('BackgroundWorkBanner', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = OpenCode.make({ baseUrl: 'http://background.test', fetch: () => new Promise<Response>(() => undefined) });

  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><BackgroundWorkBanner sessionId={parentId} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
  };
  const publish = async (sessions: Session[], statuses: Record<string, SessionStatus>) => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState({ session: sessions, session_status: statuses }));
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    ({ BackgroundWorkBanner } = await import('./BackgroundWorkBanner'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('renders nothing while no subtask is busy', async () => {
    await render();
    await publish([session(parentId), session('child', { parentID: parentId })], { child: { type: 'idle' } });
    expect(container.textContent).toBe('');
  });

  test('shows one busy subtask as its own row and drops it once its live status goes idle', async () => {
    await render();
    await publish([session(parentId), session('child-a', { parentID: parentId })], { 'child-a': { type: 'busy' } });
    expect(container.textContent).toContain('Title child-a');
    expect(container.querySelectorAll('button[aria-label^="Open "]').length).toBe(1);

    await publish([session(parentId), session('child-a', { parentID: parentId })], { 'child-a': { type: 'idle' } });
    expect(container.textContent).toBe('');
  });

  test('collapses several busy subtasks into a count that expands in place', async () => {
    await render();
    await publish(
      [session(parentId), session('child-a', { parentID: parentId }), session('child-b', { parentID: parentId, title: '  ' })],
      { 'child-a': { type: 'busy' }, 'child-b': { type: 'retry', attempt: 1, message: 'rate limited', next: 2 } },
    );
    expect(container.textContent).toContain('Running in background · 2 subtasks');
    expect(container.textContent).not.toContain('Title child-a');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('Expected the count toggle');
    await act(async () => toggle.click());
    expect(container.textContent).toContain('Title child-a');
    expect(container.textContent).toContain('Subtask');
    expect(container.querySelectorAll('button[aria-label^="Open "]').length).toBe(2);
  });

  test('opens the subtask through the session selection on a single-surface runtime', async () => {
    useUIStore.setState({ isMobile: true });
    await render();
    await publish([session(parentId), session('child', { parentID: parentId })], { child: { type: 'busy' } });

    // The real selection also admits the session's project over the network;
    // the card's contract is only that it selects the child in place.
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    const selected: Array<[string | null, string | null | undefined]> = [];
    const originalSetCurrentSession = useSessionUIStore.getState().setCurrentSession;
    await act(async () => useSessionUIStore.setState({
      setCurrentSession: (id: string | null, target?: string | null) => { selected.push([id, target]); },
    }));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Open Title child"]');
    if (!button) throw new Error('Expected subtask row button');
    await act(async () => button.click());
    useSessionUIStore.setState({ setCurrentSession: originalSetCurrentSession });
    expect(selected).toEqual([['child', directory]]);
    useUIStore.setState({ isMobile: false });
  });
});
