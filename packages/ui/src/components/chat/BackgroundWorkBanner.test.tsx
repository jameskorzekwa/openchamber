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

const parentWithPty = (): Session => session(parentId, {
  metadata: {
    openchamber: {
      backgroundJobs: {
        jobs: [{ id: 'pty_build', kind: 'pty', createdAt: Date.now() - 5_000, description: 'Waiting: build' }],
      },
    },
  },
});

describe('BackgroundWorkBanner', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = OpenCode.make({ baseUrl: 'http://background.test', fetch: () => new Promise<Response>(() => undefined) });

  const render = async (parent: Session | null) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><BackgroundWorkBanner session={parent} directory={directory} /></I18nProvider>
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

  test('renders nothing while no subtask is busy and no PTY job is registered', async () => {
    await render(session(parentId));
    await publish([session(parentId), session('child', { parentID: parentId })], { child: { type: 'idle' } });
    expect(container.textContent).toBe('');
  });

  test('lists busy subtasks and PTY jobs, and drops a subtask once its live status goes idle', async () => {
    await render(parentWithPty());
    await publish(
      [session(parentId), session('child-a', { parentID: parentId }), session('child-b', { parentID: parentId, title: '  ' })],
      { 'child-a': { type: 'busy' }, 'child-b': { type: 'busy' } },
    );

    const text = container.textContent ?? '';
    expect(text).toContain('Running in background');
    expect(text).toContain('2 subtasks · 1 process');
    expect(text).toContain('Title child-a');
    expect(text).toContain('Subtask');
    expect(text).toContain('Waiting: build');
    expect(container.querySelectorAll('button[aria-label^="Open "]').length).toBe(2);

    await publish(
      [session(parentId), session('child-a', { parentID: parentId }), session('child-b', { parentID: parentId })],
      { 'child-a': { type: 'idle' }, 'child-b': { type: 'busy' } },
    );
    const after = container.textContent ?? '';
    expect(after).not.toContain('Title child-a');
    expect(after).toContain('1 subtask · 1 process');
  });

  test('opens the subtask through the session selection on a single-surface runtime', async () => {
    useUIStore.setState({ isMobile: true });
    await render(session(parentId));
    await publish([session(parentId), session('child', { parentID: parentId })], { child: { type: 'busy' } });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Open Title child"]');
    if (!button) throw new Error('Expected subtask row button');
    const { useSessionUIStore } = await import('@/sync/session-ui-store');
    await act(async () => button.click());
    expect(useSessionUIStore.getState().currentSessionId).toBe('child');
    // Selecting a session switches the active directory, which re-targets the
    // banner's store subscription; unmount inside the test so that follow-up
    // render is accounted for before the DOM is torn down.
    await act(async () => root.unmount());
    root = createRoot(container);
    useUIStore.setState({ isMobile: false });
  });
});
