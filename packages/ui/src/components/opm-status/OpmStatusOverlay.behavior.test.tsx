import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { OpmStatusOverlay } from './OpmStatusOverlay';
import { openOpmRowSession, parseOpmSnapshot, type OpmStatusLoadResult } from './opm-status';

const availableResult = (): OpmStatusLoadResult => {
  const workRow = {
    project: 'openchamber', projectName: 'OpenChamber', ref: '1', title: 'Port status', phase: 'active', state: 'implemented', action: 'active', activityState: 'working',
    parentRef: null, branch: 'j2k/v1.21.0', sessionId: 'ses_opm', workspacePath: '/repo/worktree', reason: null, nextAction: null,
    updatedAt: 100, effect: null, children: [], kind: null, command: null, owner: { required: false, instruction: 'Nothing needed.' }, url: null,
    needsOwnerDecision: false, question: null, alias: null, activeMs: 0, activeSince: null,
    blockerKind: null, needsOperatorAttention: false, authorization: null,
  };
  return {
    status: 'supported',
    snapshot: parseOpmSnapshot({
      available: true, fetchedAt: 100, state: 'active', summary: 'Working', healthOk: true, paused: false,
      counts: { needsYou: 0, operatorAttention: 0, blocked: 0, active: 1, waiting: 0, queued: 0 },
      groups: { needsYou: [], operatorAttention: [], blocked: [], active: [workRow], waiting: [], queued: [] },
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
      expect(pill?.querySelector('[data-testid="opm-pill-total"]')?.textContent).toContain('1');
      const result = availableResult();
      if (result.status !== 'supported' || !result.snapshot.available) throw new Error('expected available snapshot');
      expect(openOpmRowSession(result.snapshot.tree[0], (id, path) => opened.push([id, path]))).toBe(true);
      expect(opened).toEqual([['ses_opm', '/repo/worktree']]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('cfg#179: isCommandActionable distinguishes dead-letter from operational stalls', async () => {
    // Import the helper to test directly
    const { isCommandActionable } = await import('./opm-status');

    // Dead letter row: kind='dead-letter' with explicit /agent resume
    // This IS actionable because dead-letter has a documented recovery path.
    // The operator sees the item in operatorAttention lane but CAN run resume.
    const deadLetterRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '10', title: 'Stalled', phase: 'blocked', state: 'implemented', action: 'blocked', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'effect session.create exhausted its retries', nextAction: null,
      updatedAt: 100, effect: { kind: 'session.create', status: 'dead_letter', attempts: 3, error: 'ENOENT' }, children: [],
      kind: 'dead-letter' as const, command: '/agent resume', owner: { required: true, instruction: 'Fix the issue then resume.' }, url: null,
      needsOwnerDecision: false, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'worker_recovery' as const, needsOperatorAttention: true, authorization: null,
    };

    // cfg#179 row: needsOwnerDecision=true but question=null, NO command exposed
    // This is NOT actionable because there's no recovery command.
    const cfg179Row = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '179', title: 'Stalled', phase: 'waiting_owner', state: 'implemented', action: 'waiting_owner', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'unsupported PR-oriented handoff', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: null, command: null, owner: { required: false, instruction: 'Nothing needed.' }, url: null,
      needsOwnerDecision: true, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'worker_recovery' as const, needsOperatorAttention: true, authorization: null,
    };

    // True owner decision with explicit command
    const ownerDecisionRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '20', title: 'Protected change', phase: 'waiting_owner', state: 'implemented', action: 'waiting_owner', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'needs owner authorisation; comment "/agent authorize abc123"', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: 'needs-owner' as const, command: '/agent authorize abc123', owner: { required: true, instruction: 'Authorize the change.' }, url: null,
      needsOwnerDecision: true, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'owner_decision' as const, needsOperatorAttention: false, authorization: null,
    };

    // Worker recovery WITHOUT dead-letter kind: has command but NOT actionable
    // This is the cfg#179 fix - worker_recovery items should not expose generic commands.
    const workerRecoveryRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '30', title: 'Recovery', phase: 'blocked', state: 'implemented', action: 'blocked', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'capability blocked', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: null, command: '/agent restart', owner: { required: false, instruction: 'Nothing needed.' }, url: null,
      needsOwnerDecision: false, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'capability_blocked' as const, needsOperatorAttention: true, authorization: null,
    };

    // Dead letter: IS actionable (documented recovery path)
    expect(isCommandActionable(deadLetterRow)).toBe(true);

    // cfg#179: NOT actionable (no command)
    expect(isCommandActionable(cfg179Row)).toBe(false);

    // True owner decision with exact command: IS actionable
    expect(isCommandActionable(ownerDecisionRow)).toBe(true);

    // Worker recovery (not dead-letter): NOT actionable despite having command
    expect(isCommandActionable(workerRecoveryRow)).toBe(false);
  });

  test('action-safety: placeholder template commands are NOT actionable', async () => {
    const { isCommandActionable } = await import('./opm-status');

    // Legacy owner gate with placeholder template command
    const placeholderRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '400', title: 'Branch binding', phase: 'waiting_owner', state: 'implemented', action: 'waiting_owner', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'owner decision required: changed branch binding', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: 'needs-owner' as const, command: '/agent decide <your decision and authorization>', owner: { required: true, instruction: 'Provide your decision.' }, url: null,
      needsOwnerDecision: true, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'owner_decision' as const, needsOperatorAttention: false, authorization: null,
    };

    // Placeholder template is NOT actionable - owner must provide real decision
    expect(isCommandActionable(placeholderRow)).toBe(false);

    // Exact protected-head command IS actionable
    const protectedHeadRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '401', title: 'Protected change', phase: 'blocked', state: 'implemented', action: 'blocked', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'protected-head policy', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: 'needs-owner' as const, command: '/agent authorize abc123def456abc123def456abc123def456abc1', owner: { required: true, instruction: 'Authorize.' }, url: null,
      needsOwnerDecision: true, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'owner_decision' as const, needsOperatorAttention: false,
      authorization: { kind: 'protected_change', sha: 'abc123def456abc123def456abc123def456abc1', command: '/agent authorize abc123def456abc123def456abc123def456abc1' },
    };
    expect(isCommandActionable(protectedHeadRow)).toBe(true);

    // Exact decision command (non-placeholder) IS actionable
    const exactDecisionRow = {
      project: 'openchamber', projectName: 'OpenChamber', ref: '402', title: 'Manual merge', phase: 'waiting_owner', state: 'implemented', action: 'waiting_owner', activityState: 'stopped',
      parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: 'owner decision required', nextAction: null,
      updatedAt: 100, effect: null, children: [],
      kind: 'needs-owner' as const, command: '/agent decide proceed with manual merge', owner: { required: true, instruction: 'Confirm.' }, url: null,
      needsOwnerDecision: true, question: null, alias: null, activeMs: 0, activeSince: null,
      blockerKind: 'owner_decision' as const, needsOperatorAttention: false, authorization: null,
    };
    expect(isCommandActionable(exactDecisionRow)).toBe(true);
  });
});
