import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import type { RunningShell } from '@/lib/opencode/background-shell';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { BackgroundShellsStrip } from '../BackgroundShellsStrip';
import { backgroundShellsRowKey, backgroundSubtasksRowKey } from '../composerRowKeys';

// The composer renders its top rows as siblings of one fragment, and keys the
// background-commands row and the subtask row by session so a session switch
// remounts them. Siblings sharing a key make React lose track of one of them
// when the key changes: the background-commands row's DOM was never removed,
// so every session switch while a command ran left one frozen row behind, in
// every session, until a page reload (observed 2026-11-12).

const testDirectory = dirname(fileURLToPath(import.meta.url));
const chatInputSource = readFileSync(join(testDirectory, '..', 'ChatInput.tsx'), 'utf8');

const session = (id: string, directory: string): Session => ({
  id, projectID: 'project', directory, title: id, cost: 0,
  time: { created: 1, updated: 1 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const COMMAND = 'sleep 30; gh run watch 1';
const backgroundShell = (startedAt: number): RunningShell => ({
  id: 'sh_1', sessionID: 'ses_root', command: COMMAND, file: '/tmp/sh_1.out', startedAt,
});

const startInBackground = (value: RunningShell): SyncEvent[] => [
  { type: 'shell.started', properties: { shell: value } },
  {
    type: 'message.tool.transition',
    properties: {
      sessionID: value.sessionID,
      messageID: 'msg_1',
      partID: 'call_1',
      transition: { kind: 'success', output: '', metadata: { status: 'running', shellID: value.id }, executed: true, end: value.startedAt },
    },
  },
];

/** Stands in for the subtask row, which renders nothing while no subtask runs. */
const SubtasksRow: React.FC<{ sessionId: string | null }> = () => null;

type KeyOf = (sessionId: string | null) => string;

/** The composer's background rows as ChatInput lays them out. */
const ComposerRows: React.FC<{ sessionId: string; shellsKey: KeyOf; subtasksKey: KeyOf }> = ({ sessionId, shellsKey, subtasksKey }) => (
  <>
    <BackgroundShellsStrip key={shellsKey(sessionId)} sessionId={sessionId} directory="/repo" />
    <SubtasksRow key={subtasksKey(sessionId)} sessionId={sessionId} />
  </>
);

describe('composer background rows across session switches', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  const originalConsoleError = console.error;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    resetBackgroundShells();
    useGlobalSessionsStore.setState({
      entityById: new Map([
        ['ses_root', session('ses_root', '/repo')],
        ['ses_a', session('ses_a', '/home')],
        ['ses_b', session('ses_b', '/home')],
      ]),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
    resetBackgroundShells();
  });

  const commandRows = () => [...host.querySelectorAll('span')].filter((span) => span.textContent === COMMAND);

  /** Opens the command's session, then two unrelated ones, then ends the command. */
  const switchSessionsWhileTheCommandRuns = async (shellsKey: KeyOf, subtasksKey: KeyOf) => {
    const render = (sessionId: string) => act(async () => {
      root.render(<I18nProvider><ComposerRows sessionId={sessionId} shellsKey={shellsKey} subtasksKey={subtasksKey} /></I18nProvider>);
    });
    await act(async () => applyBackgroundShellEvents('/repo', startInBackground(backgroundShell(Date.now() - 60_000))));
    await render('ses_root');
    expect(commandRows()).toHaveLength(1);
    await render('ses_a');
    await render('ses_root');
    await render('ses_b');
    const inUnrelatedSession = commandRows().length;
    await render('ses_root');
    await act(async () => applyBackgroundShellEvents('/repo', [
      { type: 'shell.ended', properties: { shellID: 'sh_1', end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: Date.now() } },
    ]));
    return { inUnrelatedSession, afterEnd: commandRows().length };
  };

  test('a key shared by both rows leaves frozen command rows behind (the defect)', async () => {
    // React reports the shared key; the test is about what it leaves on screen.
    console.error = () => undefined;
    const shared: KeyOf = (sessionId) => sessionId ?? '';
    const { inUnrelatedSession, afterEnd } = await switchSessionsWhileTheCommandRuns(shared, shared);
    expect(inUnrelatedSession).toBeGreaterThan(0);
    expect(afterEnd).toBeGreaterThan(0);
  });

  test('distinct row keys show the command in its own session only and drop it when it ends', async () => {
    expect(backgroundShellsRowKey('ses_root')).not.toBe(backgroundSubtasksRowKey('ses_root'));
    expect(backgroundShellsRowKey(null)).not.toBe(backgroundSubtasksRowKey(null));
    const { inUnrelatedSession, afterEnd } = await switchSessionsWhileTheCommandRuns(backgroundShellsRowKey, backgroundSubtasksRowKey);
    expect(inUnrelatedSession).toBe(0);
    expect(afterEnd).toBe(0);
  });

  test('ChatInput keys its top rows with distinct keys', () => {
    const start = chatInputSource.indexOf('const suggestionRow =');
    const end = chatInputSource.indexOf('const composerTopRows =');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const keys = [...chatInputSource.slice(start, end).matchAll(/\bkey=\{([^}]*)\}/g)].map((match) => match[1].trim());
    expect(keys).toContain('backgroundShellsRowKey(currentSessionId)');
    expect(keys).toContain('backgroundSubtasksRowKey(currentSessionId)');
    expect(new Set(keys).size).toBe(keys.length);
  });
});
