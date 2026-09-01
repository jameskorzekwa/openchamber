import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { parseOpmSnapshot, type OpmCommandResult, type OpmRow, type OpmStatusLoadResult } from './opm-status';

// Base UI's dialog popup does not mount under happy-dom, so the shared dialog
// is replaced with plain elements — the repo-wide pattern for dialog tests.
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => (open ? <>{children}</> : null),
  DialogContent: ({ children, className }: React.PropsWithChildren<{ className?: string; showCloseButton?: boolean }>) => <div data-testid="opm-dialog" className={className}>{children}</div>,
  DialogDescription: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => <p className={className}>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => <div data-testid="opm-dialog-header" className={className}>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

const { OpmStatusOverlay } = await import('./OpmStatusOverlay');

const SHA = 'a'.repeat(40);
const AUTHORIZE = `/agent authorize ${SHA}`;

const baseRow = {
  project: 'openchamber', projectName: 'OpenChamber', activityState: 'stopped',
  parentRef: null, branch: null, sessionId: null, workspacePath: null, nextAction: null,
  updatedAt: 100, effect: null, children: [], url: null,
};

const needsOwnerRow = {
  ...baseRow,
  ref: '10',
  title: 'Protected change awaiting authorization',
  phase: 'blocked',
  state: 'implemented',
  action: 'waiting_owner',
  reason: `needs owner authorisation; comment "${AUTHORIZE}"`,
  kind: 'needs-owner' as const,
  command: AUTHORIZE,
  owner: { required: true, instruction: 'Post this comment on issue #10 to approve the protected change:' },
};

const activeRow = {
  ...baseRow,
  parentRef: '10',
  ref: '20',
  title: 'Ordinary background work item',
  phase: 'active',
  state: 'implemented',
  action: 'active',
  activityState: 'working',
  reason: null,
  kind: null,
  command: null,
  owner: { required: false, instruction: 'Nothing needed.' },
};

const queuedRow = {
  ...baseRow,
  parentRef: '20',
  ref: '30',
  title: 'Nested follow-up task',
  phase: 'planned',
  state: 'planned',
  action: 'queued',
  activityState: 'queued',
  reason: 'worker limit reached',
  kind: null,
  command: null,
  owner: { required: false, instruction: 'Nothing needed.' },
};

const nestedQueuedRow = {
  ...queuedRow,
  parentRef: '30',
  ref: '40',
  title: 'Deeply nested follow-up task',
};

const availableResult = (): OpmStatusLoadResult => ({
  status: 'supported',
  snapshot: parseOpmSnapshot({
    available: true, fetchedAt: 100, state: 'active', summary: 'Working', healthOk: true, paused: false,
    counts: { needsYou: 1, blocked: 0, active: 1, waiting: 0, queued: 2 },
    groups: { needsYou: [needsOwnerRow], blocked: [], active: [activeRow], waiting: [], queued: [queuedRow, nestedQueuedRow] },
    tree: [{ ...needsOwnerRow, childRows: [{ ...activeRow, childRows: [{ ...queuedRow, childRows: [{ ...nestedQueuedRow, childRows: [] }] }] }] }],
    supervisor: { running: true, pausedReason: null, startedAt: null, lastPollAt: null, pollIntervalMs: null, counters: {}, attention: [], projects: [] },
  }),
});

describe('OpmStatusOverlay command execution and mobile rows', () => {
  let windowInstance: Window;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window({ innerWidth: 390, innerHeight: 844 });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MouseEvent: windowInstance.MouseEvent,
      sessionStorage: windowInstance.sessionStorage,
      localStorage: windowInstance.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    localStorage.clear();
  });

  afterEach(() => {
    windowInstance.close();
  });

  const mountAndOpen = async (sendCommand: (row: OpmRow) => Promise<OpmCommandResult>) => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(
      <I18nProvider>
        <OpmStatusOverlay loadStatus={async () => availableResult()} sendCommand={sendCommand} />
      </I18nProvider>,
    ));
    await act(async () => {});
    const pill = document.querySelector<HTMLButtonElement>('[aria-label="Open OPM status"]');
    if (!pill) throw new Error('pill did not render');
    await act(async () => {
      pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await act(async () => {});
  };

  const unmount = async () => {
    await act(async () => root.unmount());
  };

  const buttonsByText = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === text);

  test('Run posts the row command and shows a disabled Sent state', async () => {
    const sent: OpmRow[] = [];
    const sendCommand = mock(async (row: OpmRow): Promise<OpmCommandResult> => {
      sent.push(row);
      return { ok: true };
    });
    await mountAndOpen(sendCommand);
    try {
      const [run] = buttonsByText('Run');
      expect(run).toBeDefined();
      await act(async () => {
        run.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      await act(async () => {});
      expect(sendCommand).toHaveBeenCalledTimes(1);
      expect(sent[0]).toMatchObject({ project: 'openchamber', ref: '10', command: AUTHORIZE });
      const sentButtons = buttonsByText('Sent ✓');
      expect(sentButtons).toHaveLength(2);
      expect(sentButtons.every((button) => button.disabled)).toBe(true);
      expect(buttonsByText('Run')).toHaveLength(0);
    } finally {
      await unmount();
    }
  });

  test('a server mismatch error renders inline and leaves Run enabled', async () => {
    const sendCommand = mock(async (): Promise<OpmCommandResult> => (
      { ok: false, error: 'Command does not match the current OPM state for openchamber#10. Refresh and try again.' }
    ));
    await mountAndOpen(sendCommand);
    try {
      const [run] = buttonsByText('Run');
      await act(async () => {
        run.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      await act(async () => {});
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('does not match the current OPM state');
      const [runAgain] = buttonsByText('Run');
      expect(runAgain.disabled).toBe(false);
    } finally {
      await unmount();
    }
  });

  test('all rows stay condensed until their summary is expanded', async () => {
    await mountAndOpen(async () => ({ ok: true }));
    try {
      const workTree = document.querySelector('[data-testid="opm-work-tree"]');
      const summaries = [...(workTree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
        .filter((button) => button.textContent?.includes('OpenChamber'));
      const needsOwnerSummary = summaries.find((button) => button.textContent?.includes('Protected change'));
      const activeSummary = summaries.find((button) => button.textContent?.includes('Ordinary background'));
      expect(needsOwnerSummary?.getAttribute('aria-expanded')).toBe('false');
      expect(activeSummary?.getAttribute('aria-expanded')).toBe('false');

      const activeDetail = activeSummary?.closest('article')?.querySelector('[data-testid="opm-row-detail"]');
      expect(activeDetail?.className).toContain('hidden');
      await act(async () => {
        activeSummary?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      await act(async () => {});
      const expandedSummary = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
        .find((button) => button.textContent?.includes('Ordinary background'));
      expect(expandedSummary?.getAttribute('aria-expanded')).toBe('true');
      const expandedDetail = expandedSummary?.closest('article')?.querySelector('[data-testid="opm-row-detail"]');
      expect(expandedDetail?.className).not.toContain('hidden');
      expect(expandedDetail?.className).toContain('block');
    } finally {
      await unmount();
    }
  });

  test('mobile dialog protects its header and keeps every parent and child visible', async () => {
    await mountAndOpen(async () => ({ ok: true }));
    try {
      const dialog = document.querySelector('[data-testid="opm-dialog"]');
      expect(dialog?.className).toContain('max-sm:fixed');
      expect(dialog?.className).toContain('max-sm:h-[100dvh]');
      expect(dialog?.className).toContain('[@media(max-height:500px)]:fixed');
      expect(dialog?.className).toContain('overflow-x-hidden');

      const header = document.querySelector('[data-testid="opm-dialog-header"]');
      expect(header?.className).toContain('z-30');
      expect(header?.className).toContain('safe-area-inset-top');
      expect(header?.className).toContain('safe-area-inset-left');
      expect(header?.className).toContain('safe-area-inset-right');
      expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();
      expect(document.querySelector('[aria-label="Close"]')?.className).toContain('pointer-events-auto');
      expect(document.documentElement.classList.contains('oc-opm-dialog-open')).toBe(true);

      const needsYou = document.querySelector('[data-testid="opm-needs-you"]');
      expect(needsYou?.textContent).toContain('Protected change awaiting authorization');
      expect(needsYou?.textContent).toContain(AUTHORIZE);

      const overview = document.querySelector('[data-testid="opm-task-overview"]');
      expect(overview?.textContent).toContain('Waiting on you');
      expect(overview?.textContent).toContain('Working');
      expect(overview?.textContent).toContain('Queued');
      expect(document.querySelector('[data-testid="opm-task-total"]')?.textContent).toBe('4');
      expect(document.querySelector('[data-testid="opm-pill-total"]')?.textContent).toContain('4');

      const workTree = document.querySelector('[data-testid="opm-work-tree"]');
      const parentSummary = [...(workTree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
        .find((button) => button.textContent?.includes('Protected change'));
      const childSummary = [...(workTree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
        .find((button) => button.textContent?.includes('Ordinary background'));
      const grandchildSummary = [...(workTree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
        .find((button) => button.textContent?.includes('Nested follow-up'));
      const level4Summary = [...(workTree?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
        .find((button) => button.textContent?.includes('Deeply nested'));
      expect(parentSummary?.textContent).toContain('Parent');
      expect(parentSummary?.querySelector('[data-testid="opm-row-state"]')?.textContent).toContain('StateImplemented');
      expect(parentSummary?.querySelector('[data-testid="opm-row-action"]')?.textContent).toContain('ActionWaiting on you');
      expect(parentSummary?.querySelector('[data-testid="opm-row-action"] .font-medium')?.className).toContain('whitespace-normal');
      expect(parentSummary?.querySelector('[data-testid="opm-row-action"] .font-medium')?.className).not.toContain('truncate');
      expect(childSummary?.textContent).toContain('Parent');
      expect(childSummary?.textContent).toContain('Child');
      expect(childSummary?.querySelector('[data-testid="opm-row-state"]')?.textContent).toContain('StateImplemented');
      expect(childSummary?.querySelector('[data-testid="opm-row-action"]')?.textContent).toContain('ActionWorking');
      expect(childSummary?.closest('article')?.className).toContain('overflow-hidden');
      expect(grandchildSummary?.textContent).toContain('Child');
      expect(grandchildSummary?.textContent).toContain('Parent');
      expect(grandchildSummary?.querySelector('[data-testid="opm-row-state"]')?.textContent).toContain('StatePlanned');
      expect(grandchildSummary?.querySelector('[data-testid="opm-row-action"]')?.textContent).toContain('ActionQueued');
      expect(level4Summary?.textContent).toContain('Child');
      expect(level4Summary?.querySelector('[data-testid="opm-row-state"]')?.textContent).toContain('StatePlanned');
      expect(level4Summary?.querySelector('[data-testid="opm-row-action"]')?.textContent).toContain('ActionQueued');

      expect(parentSummary?.querySelector('[data-testid="opm-row-title"]')?.textContent).toBe('Protected change awaiting authorization');
      expect(parentSummary?.querySelector('[data-testid="opm-row-reference"]')?.textContent).toBe('OpenChamber #10');
      const collapse = workTree?.querySelector<HTMLButtonElement>('[aria-label="Collapse subtasks"]');
      expect(collapse).not.toBeNull();
      await act(async () => {
        collapse?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(workTree?.textContent).not.toContain('Ordinary background work item');
      const expand = workTree?.querySelector<HTMLButtonElement>('[aria-label="Expand subtasks"]');
      await act(async () => {
        expand?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(workTree?.textContent).toContain('Ordinary background work item');

      await act(async () => {
        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close"]');
        close?.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        close?.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
      });
      expect(document.documentElement.classList.contains('oc-opm-dialog-open')).toBe(false);
      expect(document.querySelector('[data-testid="opm-dialog"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test('the long sha command renders in a monospace span with break-all', async () => {
    await mountAndOpen(async () => ({ ok: true }));
    try {
      const code = [...document.querySelectorAll('code')].find((element) => element.textContent === AUTHORIZE);
      expect(code).toBeDefined();
      expect(code?.className).toContain('break-all');
    } finally {
      await unmount();
    }
  });
});
