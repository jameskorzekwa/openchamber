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
  activityState: 'working',
  reason: null,
  kind: null,
  command: null,
  owner: { required: false, instruction: 'Nothing needed.' },
};

const availableResult = (): OpmStatusLoadResult => ({
  status: 'supported',
  snapshot: parseOpmSnapshot({
    available: true, fetchedAt: 100, state: 'active', summary: 'Working', healthOk: true, paused: false,
    counts: { needsYou: 1, blocked: 0, active: 1, waiting: 0, queued: 0 },
    groups: { needsYou: [needsOwnerRow], blocked: [], active: [activeRow], waiting: [], queued: [] },
    tree: [{ ...needsOwnerRow, childRows: [{ ...activeRow, childRows: [] }] }],
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
      expect(sentButtons).toHaveLength(1);
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
      const summaries = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
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
      expect(dialog?.className).toContain('overflow-x-hidden');

      const header = document.querySelector('[data-testid="opm-dialog-header"]');
      expect(header?.className).toContain('z-30');
      expect(header?.className).toContain('safe-area-inset-top');
      expect(document.querySelector('[aria-label="Close"]')).not.toBeNull();

      const overview = document.querySelector('[data-testid="opm-task-overview"]');
      expect(overview?.textContent).toContain('Waiting on you');
      expect(overview?.textContent).toContain('Working');
      expect(overview?.textContent).toContain('Queued');

      const parentSummary = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
        .find((button) => button.textContent?.includes('Protected change'));
      const childSummary = [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
        .find((button) => button.textContent?.includes('Ordinary background'));
      expect(parentSummary?.textContent).toContain('Parent');
      expect(parentSummary?.textContent).toContain('Blocked');
      expect(childSummary?.textContent).toContain('Child');
      expect(childSummary?.textContent).toContain('Working');
      expect(childSummary?.closest('article')?.className).toContain('overflow-hidden');
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
