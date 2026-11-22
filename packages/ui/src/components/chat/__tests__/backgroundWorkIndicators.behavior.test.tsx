import React from 'react';
import { expect, spyOn, test } from 'bun:test';
import { act, BackgroundWorkBanner, browser, COMMAND, mountComposer, session, useUIStore } from './backgroundComposer.test-support';

test('the composer docks the subtask row immediately after background commands', async () => {
  const view = await mountComposer();
  try {
    await act(async () => view.store.setState({ session_status: { ses_child: { type: 'busy' } } }));
    await view.startCommand();
    const command = [...view.host.querySelectorAll('span')].find((span) => span.textContent === COMMAND)?.closest('[role="group"]');
    const subtask = [...view.host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('Title ses_child'))?.closest('[role="group"]');
    expect(command).toBeDefined();
    expect(subtask).toBeDefined();
    expect(command?.nextElementSibling).toBe(subtask);
    await view.endCommand();
    expect(subtask?.isConnected).toBe(true);
  } finally {
    await view.close();
  }
});

test('live child status controls subtask visibility and clicking opens the child session', async () => {
  const view = await mountComposer();
  try {
    expect(view.host.textContent).not.toContain('Title ses_child');
    await act(async () => view.store.setState({ session_status: { ses_child: { type: 'busy' } } }));
    const subtask = [...view.host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('Title ses_child'));
    expect(subtask).toBeDefined();
    await act(async () => subtask?.click());
    const tabs = useUIStore.getState().contextPanelByDirectory['/workspace']?.tabs ?? [];
    expect(tabs.some((tab) => tab.mode === 'chat' && tab.dedupeKey === 'session:ses_child')).toBe(true);
    await act(async () => view.store.setState({ session_status: { ses_child: { type: 'idle' } } }));
    expect(view.host.textContent).not.toContain('Title ses_child');
    expect(view.store.getState().session.some((value) => value.id === 'ses_child')).toBe(true);
  } finally {
    await view.close();
  }
});

test('several subtask durations share one clock and the row has no spinning or pulsing animation', async () => {
  const view = await mountComposer(<BackgroundWorkBanner sessionId="ses_parent" directory="/workspace" />);
  const now = spyOn(Date, 'now');
  now.mockReturnValue(120_000);
  const intervals = spyOn(browser, 'setInterval');
  try {
    const first = { ...session('ses_child', 'ses_parent'), time: { created: 60_000, updated: 60_000 } };
    const second = { ...session('ses_child2', 'ses_parent'), time: { created: 60_000, updated: 60_000 } };
    await act(async () => view.store.setState({
      session: [session('ses_parent'), first, second],
      session_status: { ses_child: { type: 'busy' }, ses_child2: { type: 'busy' } },
    }));
    const expand = view.host.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(expand).not.toBeNull();
    await act(async () => expand?.click());
    expect(view.host.querySelectorAll('[class*="animate-spin"], [class*="animate-pulse"]')).toHaveLength(0);
    expect(intervals.mock.calls).toHaveLength(1);
    expect(intervals.mock.calls[0]?.[1]).toBe(1000);
    expect(view.host.textContent).toContain('1m');
    now.mockReturnValue(180_000);
    await act(async () => {
      const tick = intervals.mock.calls[0]?.[0];
      if (tick instanceof Function) tick();
    });
    expect(view.host.textContent).toContain('2m');
  } finally {
    await view.close();
    intervals.mockRestore();
    now.mockRestore();
  }
});

test('clicking a background command opens its read-only output in the side panel', async () => {
  const view = await mountComposer();
  try {
    await view.startCommand();
    const command = [...view.host.querySelectorAll('span')].find((span) => span.textContent === COMMAND);
    const row = command?.closest('[role="group"]');
    const open = row?.querySelector<HTMLButtonElement>('button[aria-label*="output"]');
    expect(open).not.toBeNull();
    await act(async () => open?.click());
    const tabs = useUIStore.getState().contextPanelByDirectory['/workspace']?.tabs ?? [];
    expect(tabs.find((tab) => tab.mode === 'pty' && tab.dedupeKey === 'sh_child')).toMatchObject({
      mode: 'pty', dedupeKey: 'sh_child', targetDirectory: null, label: COMMAND, readOnly: true,
    });
  } finally {
    await view.close();
  }
});
