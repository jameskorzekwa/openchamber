import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';

/**
 * The composer's background rows with the real ChatInput (harness as in
 * ChatInput.keystroke.test.tsx).
 *
 * Observed 2026-11-12: while a subagent's background command and a running
 * subtask were shown above the composer, every keystroke added one more
 * frozen copy of the command's row. The background-commands row and the
 * subtask row are siblings of one fragment and both were keyed by the session
 * id; React reported "two children with the same key" and left the old
 * command row's DOM behind on every ChatInput render.
 */
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Nothing typed here reaches a server; settings retain the admitted project.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path === '/api/config/settings') return Response.json({ projects: [{ id: 'project', path: '/workspace' }] });
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches.
plugin({
  name: 'composer-keystroke-vite-modules',
  setup(build) {
    // A load transform, as the sibling tests do it, and never an onResolve into a namespace of
    // its own: Bun keeps transpiled files in a cache on disk that every test process shares, and
    // a rewritten import specifier cached from this file broke every later file that imports
    // markdown-worker with "Cannot find module 'worker-url:...'".
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { OpenCode } = await import('@opencode/client');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { applyBackgroundShellEvents } = await import('@/sync/background-shells');
useProjectsStore.setState({ projects: [{ id: 'project', path: '/workspace' }] });

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting and typing read only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

afterAll(() => {
  browser.close();
});

const session = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: 'project', directory: '/workspace', title: `Title ${id}`, cost: 0,
  time: { created: Date.now() - 60_000, updated: Date.now() },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const COMMAND = 'sleep 600 # subagent watcher';

test('typing while a subagent command and a subtask run keeps one command row', async () => {
  const errors: string[] = [];
  const consoleError = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({ currentSessionId: 'ses_parent', currentSessionDirectory: '/workspace' });
  const parent = session('ses_parent');
  const child = session('ses_child', 'ses_parent');
  useGlobalSessionsStore.setState({ entityById: new Map([[parent.id, parent], [child.id, child]]) });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory="/workspace">
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => {
      await ensureHomeDirectoryResolved();
      await updateDesktopSettings({});
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
    });
    const store = getSyncChildStores().ensureChild('/workspace', { bootstrap: false });
    await act(async () => {
      store.setState({ session: [parent, child], session_status: { ses_child: { type: 'busy' } } });
    });
    await act(async () => {
      applyBackgroundShellEvents('/workspace', [
        { type: 'shell.started', properties: { shell: { id: 'sh_child', sessionID: 'ses_child', command: COMMAND, file: '/tmp/sh_child.out', startedAt: Date.now() - 30_000 } } },
        { type: 'message.tool.transition', properties: { sessionID: 'ses_child', messageID: 'msg_1', partID: 'call_1', transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_child' }, executed: true, end: Date.now() } } },
      ]);
    });
    const rows = () => [...container.querySelectorAll('span')].filter((span) => span.textContent === COMMAND).length;
    expect(rows()).toBe(1);
    // The subtask row has to be on screen too: it is the sibling that collided.
    expect(container.textContent).toContain('Title ses_child');
    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error('The composer editor did not mount');
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' }, userEvent: 'input.type' });
      });
      // Before the fix: 2, 3, 4, 5, 6.
      expect([index + 1, rows()]).toEqual([index + 1, 1]);
    }
    expect(view.state.doc.length).toBe(5);
    expect(errors.filter((message) => message.includes('two children with the same key'))).toEqual([]);
  } finally {
    consoleError.mockRestore();
    await act(async () => root.unmount());
    container.remove();
  }
});
