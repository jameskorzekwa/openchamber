import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { OpmStatusOverlay } from './OpmStatusOverlay';
import { openOpmRowSession, parseOpmSnapshot, type OpmStatusLoadResult } from './opm-status';

const availableResult = (): OpmStatusLoadResult => {
  const workRow = {
    project: 'openchamber', projectName: 'OpenChamber', ref: '1', title: 'Port status', phase: 'active', activityState: 'working',
    parentRef: null, branch: 'j2k/v1.21.0', sessionId: 'ses_opm', workspacePath: '/repo/worktree', reason: null, nextAction: null,
    updatedAt: 100, effect: null, children: [], kind: null, command: null, owner: { required: false, instruction: 'Nothing needed.' }, url: null,
  };
  return {
    status: 'supported',
    snapshot: parseOpmSnapshot({
      available: true, fetchedAt: 100, state: 'active', summary: 'Working', healthOk: true, paused: false,
      counts: { needsYou: 0, blocked: 0, active: 1, waiting: 0, queued: 0 },
      groups: { needsYou: [], blocked: [], active: [workRow], waiting: [], queued: [] },
      tree: [{ ...workRow, childRows: [] }],
      supervisor: { running: true, pausedReason: null, startedAt: null, lastPollAt: null, pollIntervalMs: null, counters: {}, attention: [], projects: [] },
    }),
  };
};

describe('OpmStatusOverlay behavior', () => {
  let windowInstance: Window;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MouseEvent: windowInstance.MouseEvent,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
  });

  afterEach(() => {
    windowInstance.close();
  });

  test('renders nothing when the active runtime does not own the route', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider><OpmStatusOverlay loadStatus={async () => ({ status: 'unsupported' })} /></I18nProvider>));
      await act(async () => {});
      expect(document.querySelector('[aria-label="Open OPM status"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('renders live status and opens a row with its authoritative workspace path', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const opened: Array<[string, string | null]> = [];
    try {
      await act(async () => root.render(<I18nProvider><OpmStatusOverlay loadStatus={async () => availableResult()} openSession={(id, path) => opened.push([id, path])} /></I18nProvider>));
      await act(async () => {});
      const pill = document.querySelector('[aria-label="Open OPM status"]');
      expect(pill).not.toBeNull();
      expect(pill?.textContent).toContain('working (1)');
      const result = availableResult();
      if (result.status !== 'supported' || !result.snapshot.available) throw new Error('expected available snapshot');
      expect(openOpmRowSession(result.snapshot.tree[0], (id, path) => opened.push([id, path]))).toBe(true);
      expect(opened).toEqual([['ses_opm', '/repo/worktree']]);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
