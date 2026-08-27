import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { OpmStatusOverlay } from './OpmStatusOverlay';
import { parseOpmSnapshot, type OpmStatusLoadResult } from './opm-status';

const POS_KEY = 'opmStatus.pillPos';

const availableResult = (): OpmStatusLoadResult => {
  const workRow = {
    project: 'openchamber', projectName: 'OpenChamber', ref: '1', title: 'Port status', phase: 'active', activityState: 'working',
    parentRef: null, branch: null, sessionId: null, workspacePath: null, reason: null, nextAction: null,
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

describe('OpmStatusOverlay pill drag', () => {
  let windowInstance: Window;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window({ innerWidth: 1024, innerHeight: 768 });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MouseEvent: windowInstance.MouseEvent,
      PointerEvent: windowInstance.PointerEvent,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    localStorage.clear();
  });

  afterEach(() => {
    windowInstance.close();
  });

  const mountPill = async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<I18nProvider><OpmStatusOverlay loadStatus={async () => availableResult()} /></I18nProvider>));
    await act(async () => {});
    const pill = document.querySelector<HTMLButtonElement>('[aria-label="Open OPM status"]');
    if (!pill) throw new Error('pill did not render');
    // happy-dom performs no layout; report a rect that follows the inline
    // styles the drag logic writes, from the default bottom-right otherwise.
    pill.getBoundingClientRect = () => {
      const left = Number.parseFloat(pill.style.left);
      const top = Number.parseFloat(pill.style.top);
      return {
        left: Number.isFinite(left) ? left : 900,
        top: Number.isFinite(top) ? top : 700,
        width: 90,
        height: 30,
        right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    };
    pill.setPointerCapture = () => {};
    pill.releasePointerCapture = () => {};
    return pill;
  };

  const pointer = (pill: HTMLElement, type: string, clientX: number, clientY: number) => {
    pill.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, button: 0 }));
  };

  const unmount = async () => {
    await act(async () => root.unmount());
  };

  test('a stored top-edge position is applied on mount, reapplied on resize, and respects the safe area inset', async () => {
    localStorage.setItem(POS_KEY, JSON.stringify({ edge: 'top', offset: 0.5 }));
    const pill = await mountPill();
    try {
      // maxX = 1024 - 90 - 12 = 922; left = round(6 + 0.5 * 922) = 467.
      expect(pill.style.left).toBe('467px');
      expect(pill.style.bottom).toBe('auto');
      expect(pill.style.right).toBe('auto');

      // happy-dom's CSS parser drops calc(env(...)) values, so the safe-area
      // top is asserted through a plain style stand-in fed by the resize path.
      const fakeStyle: Record<string, string> = {};
      Object.defineProperty(pill, 'style', { value: fakeStyle, configurable: true });
      await act(async () => {
        window.dispatchEvent(new window.Event('resize'));
      });
      expect(fakeStyle.top).toBe('calc(env(safe-area-inset-top, 0px) + 6px)');
      expect(fakeStyle.left).toBe('467px');
      expect(fakeStyle.bottom).toBe('auto');
    } finally {
      await unmount();
    }
  });

  test('without a stored position the default CSS placement is untouched', async () => {
    const pill = await mountPill();
    try {
      expect(pill.style.left).toBe('');
      expect(pill.style.top).toBe('');
    } finally {
      await unmount();
    }
  });

  test('movement below the 5px threshold stays a click: dashboard opens, nothing persists', async () => {
    const pill = await mountPill();
    try {
      await act(async () => {
        pointer(pill, 'pointerdown', 945, 715);
        pointer(pill, 'pointermove', 947, 717);
        pointer(pill, 'pointerup', 947, 717);
        pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(pill.getAttribute('aria-expanded')).toBe('true');
      expect(localStorage.getItem(POS_KEY)).toBeNull();
      expect(pill.style.left).toBe('');
    } finally {
      await unmount();
    }
  });

  test('a drag past the threshold snaps to the nearest edge, persists, and never opens the dashboard', async () => {
    const pill = await mountPill();
    try {
      await act(async () => {
        pointer(pill, 'pointerdown', 945, 715);
        pointer(pill, 'pointermove', 500, 715);
        pointer(pill, 'pointermove', 60, 400);
        pointer(pill, 'pointerup', 60, 400);
        pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(pill.getAttribute('aria-expanded')).toBe('false');

      const stored = JSON.parse(localStorage.getItem(POS_KEY) ?? 'null');
      expect(stored.edge).toBe('left');
      // Release left the pill at (15, 385): offset = (385 - 6) / (768 - 30 - 12).
      expect(stored.offset).toBeCloseTo(379 / 726, 5);
      expect(pill.style.left).toBe('6px');
      expect(pill.style.top).toBe('385px');

      // Once the release settles, the next plain click opens the dashboard again.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      await act(async () => {
        pointer(pill, 'pointerdown', 20, 390);
        pointer(pill, 'pointerup', 20, 390);
        pill.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
      });
      expect(pill.getAttribute('aria-expanded')).toBe('true');
    } finally {
      await unmount();
    }
  });

  test('a persisted position survives a remount round-trip', async () => {
    const pill = await mountPill();
    try {
      await act(async () => {
        pointer(pill, 'pointerdown', 945, 715);
        pointer(pill, 'pointermove', 60, 400);
        pointer(pill, 'pointerup', 60, 400);
      });
    } finally {
      await unmount();
    }

    const remounted = await mountPill();
    try {
      expect(remounted.style.left).toBe('6px');
      expect(remounted.style.top).toBe('385px');
    } finally {
      await unmount();
    }
  });

  test('the mobile capsule renders the salient count next to the dot while text stays desktop-only', async () => {
    const pill = await mountPill();
    try {
      const text = pill.querySelector('span.hidden');
      expect(text?.textContent).toBe('OPM · working (1)');
      expect(text?.className).toContain('sm:inline');
      const capsule = pill.querySelector('span.font-bold');
      expect(capsule?.textContent).toBe('1');
      expect(capsule?.className).toContain('sm:hidden');
    } finally {
      await unmount();
    }
  });
});
