import { afterAll, spyOn } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';
import type { Session } from '@/lib/opencode/model';
import type { SyncEvent } from '@/lib/opencode/events';

export const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Text: browser.Text, Element: browser.Element,
  HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range, Selection: browser.Selection, DocumentFragment: browser.DocumentFragment,
  Event: browser.Event, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent, InputEvent: browser.InputEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver, matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements, HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement, SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot, CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser, IS_REACT_ACT_ENVIRONMENT: true,
});

const fetchFixture = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path === '/api/config/settings') return Response.json({ projects: [{ id: 'project', path: '/workspace' }] });
  if (path === '/api/session-warming') return Response.json({ revision: 1, enabled: false, minutes: 5, sessions: [] });
  if (path === '/api/git/projects') return Response.json({ projects: [{ directory: '/workspace', isGitRepository: false }] });
  if (path.endsWith('/config')) return Response.json([]);
  if (path.endsWith('/project')) return Response.json([]);
  if (path === '/api/fs/home') return Response.json({ home: '/home/test' });
  if (path.endsWith('/location')) return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

plugin({
  name: 'background-composer-vite-assets',
  setup(build) {
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

const React = await import('react');
export const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../../web/src/api');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore, ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { OpenCode } = await import('@opencode/client');
export const { useSessionUIStore } = await import('@/sync/session-ui-store');
export const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { applyBackgroundShellEvents, resetBackgroundShells } = await import('@/sync/background-shells');
export const { BackgroundWorkBanner } = await import('../BackgroundWorkBanner');

afterAll(async () => {
  await browser.happyDOM.close();
  fetchFixture.mockRestore();
});

export const session = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: 'project', directory: '/workspace', title: `Title ${id}`, cost: 0,
  time: { created: Date.now() - 60_000, updated: Date.now() },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

export const COMMAND = 'sleep 600 # subagent watcher';

export const mountComposer = async (content?: ReactNode) => {
  resetBackgroundShells();
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/workspace' }] });
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({
    currentSessionId: 'ses_parent', currentSessionDirectory: '/workspace',
    newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false },
  });
  useUIStore.setState({ isMobile: false, contextPanelByDirectory: {} });
  const sessions = [session('ses_parent'), session('ses_child', 'ses_parent'), session('ses_a'), session('ses_b')];
  useGlobalSessionsStore.setState({ entityById: new Map(sessions.map((value) => [value.id, value])) });
  const sdk = OpenCode.make({
    baseUrl: 'https://sync.test',
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/location')) return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
      return Response.json(path.endsWith('/session/active') ? {} : { data: [] });
    },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const runtime = createWebAPIs();
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtime}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory="/workspace">{content ?? <ChatInput />}</SyncProvider>
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
  await act(async () => store.setState({ session: sessions, session_status: {} }));
  return {
    host, store,
    select: (id: string) => act(async () => useSessionUIStore.getState().setCurrentSession(id, '/workspace')),
    startCommand: () => act(async () => applyBackgroundShellEvents('/workspace', [
      { type: 'shell.started', properties: { shell: { id: 'sh_child', sessionID: 'ses_child', command: COMMAND, file: '/tmp/sh_child.out', startedAt: Date.now() - 30_000 } } },
      { type: 'message.tool.transition', properties: { sessionID: 'ses_child', messageID: 'msg_1', partID: 'call_1', transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: 'sh_child' }, executed: true, end: Date.now() } } },
    ])),
    endCommand: () => act(async () => {
      const event: SyncEvent = { type: 'shell.ended', properties: { shellID: 'sh_child', end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: Date.now() } };
      applyBackgroundShellEvents('/workspace', [event]);
    }),
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      resetBackgroundShells();
    },
  };
};
