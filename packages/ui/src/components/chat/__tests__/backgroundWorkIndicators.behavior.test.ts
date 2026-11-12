import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const chatInputSource = readFileSync(join(testDirectory, '..', 'ChatInput.tsx'), 'utf8');
const bannerSource = readFileSync(join(testDirectory, '..', 'BackgroundWorkBanner.tsx'), 'utf8');
const shellsStripSource = readFileSync(join(testDirectory, '..', 'BackgroundShellsStrip.tsx'), 'utf8');

describe('background work indicator integration', () => {
  test('docks the subtask row right after the background-commands row of the composer', () => {
    const shells = chatInputSource.indexOf('{backgroundShellsRow}');
    const subtasks = chatInputSource.indexOf('{backgroundSubtasksRow}');
    expect(shells).toBeGreaterThan(-1);
    expect(subtasks).toBeGreaterThan(shells);
    expect(chatInputSource).toContain('backgroundShellsRow || backgroundSubtasksRow');
  });

  test('lists subtasks from live child status only', () => {
    expect(bannerSource).toContain('listRunningSubtasks(sessions, statuses, sessionId)');
    expect(bannerSource).toContain('state.session_status');
    expect(bannerSource).toContain('openChildSession(subtask.id, label)');
  });

  test('runs no infinite animation and no timer of its own', () => {
    expect(bannerSource).not.toContain('animate-pulse');
    expect(bannerSource).not.toContain('animate-spin');
    expect(bannerSource).not.toContain('setInterval');
    expect(bannerSource).toContain('useDurationTickerNow');
  });

  test('background commands open their output in the side panel', () => {
    expect(shellsStripSource).toContain('openShellOutput(shell.id, shell.directory, shell.command)');
    expect(shellsStripSource).toContain('onOpenOutput={openOutput}');
  });
});
