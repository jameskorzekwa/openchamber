import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { parseOpmSnapshot, type OpmPauseResult, type OpmStatusLoadResult } from './opm-status';

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => (open ? <>{children}</> : null),
  DialogContent: ({ children, className }: React.PropsWithChildren<{ className?: string; showCloseButton?: boolean }>) => <div data-testid="opm-dialog" className={className}>{children}</div>,
  DialogDescription: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => <p className={className}>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => <div data-testid="opm-dialog-header" className={className}>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { OpmStatusOverlay } = await import('./OpmStatusOverlay');

const NOW = Date.now();
const baseRow = {
  activityState: 'stopped', parentRef: null, branch: null, sessionId: null, workspacePath: null, nextAction: null,
  updatedAt: NOW - 60_000, effect: null, children: [], needsOwnerDecision: false, question: null, kind: null, command: null,
  owner: { required: false, instruction: 'Nothing needed.' }, activeMs: 0, activeSince: null,
};
const hh = { project: 'heirloom-hotline', projectName: 'Heirloom Hotline', alias: 'hh' };
const opm = { project: 'opencode-project-manager', projectName: 'OpenCode Project Manager', alias: 'opm' };

const decisionRow = {
  ...baseRow, ...hh, ref: '797', title: 'Bound pickup-to-greeting latency at two seconds', phase: 'waiting_owner',
  state: 'implemented', action: 'waiting_owner', reason: 'owner decision required: review rejected', needsOwnerDecision: true,
  kind: 'owner-question' as const, command: '/agent decide A',
  question: { id: 'q1', askedBy: 'reviewer', text: 'Hardware evidence is owner-only. How should this proceed?', url: 'https://example.test/797#q', options: [
    { key: 'A', label: 'Run on the canary device', detail: 'CI flashes and tests', command: '/agent decide A' },
    { key: 'B', label: 'I will test it', detail: '', command: '/agent decide B' },
  ] },
  owner: { required: true, instruction: 'Hardware evidence is owner-only. How should this proceed?' },
  url: 'https://example.test/797',
};
const runningRow = {
  ...baseRow, ...hh, ref: '798', title: 'Hardware-evidence gate: build a dev artifact and test on the canary device, or ask the owner with exact steps', phase: 'active',
  state: 'implemented', action: 'reviewing', activityState: 'working', sessionId: 'ses_1', reason: null,
  activeMs: 600_000, activeSince: new Date(NOW - 120_000).toISOString(), url: 'https://example.test/798',
};
const waitingRow = {
  ...baseRow, ...opm, ref: '163', title: 'Verify provider: pass through structured reasons', phase: 'waiting_external',
  state: 'implemented', action: 'waiting_external', reason: 'waiting for checks on 00732b6b', activeMs: 900_000, url: 'https://example.test/163',
};
const backlogRow = {
  ...baseRow, ...opm, ref: '170', title: 'Plugin host: retry after a config load failure', phase: 'planned',
  state: 'planned', action: 'queued', activityState: 'queued', reason: 'queued: project is at its 1-worker limit', url: 'https://example.test/170',
};

const lane = (row: Record<string, unknown>, laneName: 'needsYou' | 'running' | 'waiting' | 'backlog') => ({ ...row, lane: laneName });

const snapshotPayload = ({ paused = false, withGroups = true } = {}) => ({
  available: true as const, fetchedAt: NOW, state: 'active', summary: 'Working', healthOk: true, paused,
  counts: { needsYou: 1, blocked: 0, active: 1, waiting: 1, queued: 1 },
  groups: { needsYou: [decisionRow], blocked: [], active: [runningRow], waiting: [waitingRow], queued: [backlogRow] },
  tree: [decisionRow, runningRow, waitingRow, backlogRow].map((row) => ({ ...row, childRows: [] })),
  ...(withGroups ? {
    byProject: [
      { ...hh, counts: { needsYou: 1, running: 1, waiting: 0, backlog: 0 }, items: [lane(decisionRow, 'needsYou'), lane(runningRow, 'running')] },
      { ...opm, counts: { needsYou: 0, running: 0, waiting: 1, backlog: 1 }, items: [lane(waitingRow, 'waiting'), lane(backlogRow, 'backlog')] },
      { project: 'duck-race-manager', projectName: 'QuickDucks', alias: 'ducks', counts: { needsYou: 0, running: 0, waiting: 0, backlog: 0 }, items: [] },
    ],
    completed: [{ ...hh, ref: '765', title: 'Restore StaffAuthProofControl DeleteItem permission', url: 'https://example.test/765', completedAt: new Date(NOW - 3_600_000).toISOString(), activeMs: 2_700_000 }],
    completedTotal: 58,
  } : {}),
  supervisor: {
    running: true, pausedReason: null, startedAt: null, lastPollAt: NOW - 30_000, pollIntervalMs: 90_000, counters: {}, attention: [],
    projects: [{ projectId: 'uuid-hh', ...hh, passes: 12, failures: 0, lastPassAt: NOW, degraded: false, degradedReason: null, rateLimited: false, lastError: null }],
  },
});

describe('OpmStatusOverlay project groups, lanes, active clock, pause, completed', () => {
  let windowInstance: Window;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window({ innerWidth: 390, innerHeight: 844 });
    Object.assign(globalThis, {
      window: windowInstance, document: windowInstance.document, navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement, Element: windowInstance.Element, Node: windowInstance.Node,
      MouseEvent: windowInstance.MouseEvent, sessionStorage: windowInstance.sessionStorage, localStorage: windowInstance.localStorage,
      requestAnimationFrame: (callback: FrameRequestCallback) => windowInstance.setTimeout(() => callback(Date.now()), 0),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    windowInstance.HTMLElement.prototype.scrollIntoView = mock(() => {});
    localStorage.clear();
  });
  afterEach(() => { windowInstance.close(); });

  const mountAndOpen = async (options: { paused?: boolean; withGroups?: boolean; setPaused?: (paused: boolean) => Promise<OpmPauseResult> } = {}) => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const loadStatus = async (): Promise<OpmStatusLoadResult> => ({ status: 'supported', snapshot: parseOpmSnapshot(snapshotPayload(options)) });
    await act(async () => root.render(
      <I18nProvider>
        <OpmStatusOverlay loadStatus={loadStatus} sendCommand={async () => ({ ok: true })} setPaused={options.setPaused ?? (async (paused) => ({ ok: true, paused }))} />
      </I18nProvider>,
    ));
    await act(async () => {});
    const pill = document.querySelector<HTMLButtonElement>('[aria-label="Open OPM status"]');
    if (!pill) throw new Error('pill did not render');
    await act(async () => { pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 })); });
    await act(async () => {});
    return async () => { await act(async () => root.unmount()); };
  };

  test('groups tasks by project with lanes in owner order; empty projects collapse to a header', async () => {
    const unmount = await mountAndOpen();
    try {
      const groups = [...document.querySelectorAll('[data-testid="opm-project-group"]')];
      expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Heirloom Hotline', 'OpenCode Project Manager', 'QuickDucks']);
      const laneNames = (group: Element) => [...group.querySelectorAll('[data-testid^="opm-lane-"]')].map((el) => el.getAttribute('data-testid'));
      expect(laneNames(groups[0])).toEqual(['opm-lane-needsYou', 'opm-lane-running']);
      expect(laneNames(groups[1])).toEqual(['opm-lane-waiting', 'opm-lane-backlog']);
      expect(laneNames(groups[2])).toEqual([]);
      expect(groups[2].textContent).toContain('QuickDucks');
      expect(document.querySelector('[data-testid="opm-work-tree"]')).toBeNull();
    } finally { await unmount(); }
  });

  test('a row keeps title and value-only badges on one line and never prints the words State or Action', async () => {
    const unmount = await mountAndOpen();
    try {
      const running = document.querySelector('[data-testid="opm-lane-running"]');
      const title = running?.querySelector('[data-testid="opm-row-title"]');
      const state = running?.querySelector('[data-testid="opm-row-state"]');
      const action = running?.querySelector('[data-testid="opm-row-action"]');
      expect(title?.className).toContain('truncate');
      expect(title?.parentElement).toBe(state?.parentElement?.parentElement);
      expect(state?.textContent).toBe('Implemented');
      expect(action?.textContent).toBe('Reviewing');
      const dialogText = document.querySelector('[data-testid="opm-dialog"]')?.textContent ?? '';
      expect(dialogText).not.toMatch(/\bState\b/);
      expect(dialogText).not.toMatch(/\bAction\b/);
      expect(running?.querySelector('[data-testid="opm-row-reference"]')?.textContent).toBe('hh#798');
    } finally { await unmount(); }
  });

  test('shows a live active readout while worked and a banked readout once stopped', async () => {
    const unmount = await mountAndOpen();
    try {
      const running = document.querySelector('[data-testid="opm-lane-running"] [data-testid="opm-row-active"]');
      expect(running?.textContent).toMatch(/active 1[12]m/);
      const waiting = document.querySelector('[data-testid="opm-lane-waiting"] [data-testid="opm-row-active"]');
      expect(waiting?.textContent).toBe('· worked 15m');
      expect(document.querySelector('[data-testid="opm-lane-backlog"] [data-testid="opm-row-active"]')).toBeNull();
    } finally { await unmount(); }
  });

  test('renders an owner question with copyable exact commands in the needs-you lane', async () => {
    const unmount = await mountAndOpen();
    try {
      const question = document.querySelector('[data-testid="opm-lane-needsYou"] [data-testid="opm-owner-question"]');
      expect(question?.textContent).toContain('Hardware evidence is owner-only');
      expect(question?.textContent).toContain('A — Run on the canary device');
      expect(question?.querySelectorAll('button').length).toBe(3);
    } finally { await unmount(); }
  });

  test('the pause switch toggles the supervisor and shows the paused banner', async () => {
    const calls: boolean[] = [];
    const unmount = await mountAndOpen({ setPaused: async (paused) => { calls.push(paused); return { ok: true, paused }; } });
    try {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="opm-pause-switch"]');
      expect(button?.textContent).toContain('Pause OPM');
      expect(document.querySelector('[data-testid="opm-paused-banner"]')).toBeNull();
      await act(async () => { button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 })); });
      await act(async () => {});
      expect(calls).toEqual([true]);
      expect(document.querySelector('[data-testid="opm-paused-banner"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="opm-pause-switch"]')?.textContent).toContain('Resume OPM');
    } finally { await unmount(); }
  });

  test('lists completed work with its count and banked active time', async () => {
    const unmount = await mountAndOpen();
    try {
      const completed = document.querySelector('[data-testid="opm-completed"]');
      expect(completed?.textContent).toContain('58 total · 1 in the last 7 days');
      expect(completed?.textContent).toContain('hh#765');
      expect(completed?.textContent).toContain('worked 45m');
      expect(document.querySelector('[data-testid="opm-task-overview"]')?.textContent).toContain('58');
    } finally { await unmount(); }
  });

  test('an older server without byProject still renders the flat hierarchy', async () => {
    const unmount = await mountAndOpen({ withGroups: false });
    try {
      expect(document.querySelector('[data-testid="opm-project-group"]')).toBeNull();
      expect(document.querySelector('[data-testid="opm-work-tree"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="opm-completed"]')).toBeNull();
    } finally { await unmount(); }
  });
});
