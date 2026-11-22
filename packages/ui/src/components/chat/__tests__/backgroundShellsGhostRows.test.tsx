import { expect, spyOn, test } from 'bun:test';
import { act, COMMAND, mountComposer } from './backgroundComposer.test-support';

test('the composer removes background command rows across session switches and completion', async () => {
  const view = await mountComposer();
  const commandRows = () => [...view.host.querySelectorAll('span')].filter((span) => span.textContent === COMMAND);
  try {
    await view.startCommand();
    expect(commandRows()).toHaveLength(1);
    for (const id of ['ses_a', 'ses_parent', 'ses_b', 'ses_parent']) {
      await view.select(id);
      expect(commandRows()).toHaveLength(id === 'ses_parent' ? 1 : 0);
    }
    await view.endCommand();
    expect(commandRows()).toHaveLength(0);
  } finally {
    await view.close();
  }
});

test('the real composer keeps command and live-subtask siblings distinct during reconciliation', async () => {
  const errors: string[] = [];
  const report = spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.map(String).join(' ')); });
  const view = await mountComposer();
  try {
    await act(async () => view.store.setState({ session_status: { ses_child: { type: 'busy' } } }));
    await view.startCommand();
    for (const id of ['ses_a', 'ses_parent', 'ses_b', 'ses_parent']) {
      await view.select(id);
      const commands = [...view.host.querySelectorAll('span')].filter((span) => span.textContent === COMMAND);
      const subtasks = [...view.host.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label')?.includes('Title ses_child'));
      expect(commands).toHaveLength(id === 'ses_parent' ? 1 : 0);
      expect(subtasks).toHaveLength(id === 'ses_parent' ? 1 : 0);
    }
    expect(errors.filter((message) => message.includes('same key'))).toEqual([]);
  } finally {
    await view.close();
    report.mockRestore();
  }
});
