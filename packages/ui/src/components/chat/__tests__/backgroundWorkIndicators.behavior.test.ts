import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const chatContainerSource = readFileSync(join(testDirectory, '..', 'ChatContainer.tsx'), 'utf8');
const chatInputSource = readFileSync(join(testDirectory, '..', 'ChatInput.tsx'), 'utf8');
const bannerSource = readFileSync(join(testDirectory, '..', 'BackgroundWorkBanner.tsx'), 'utf8');
const sidebarSource = readFileSync(
  join(testDirectory, '..', '..', 'session', 'sidebar', 'sessions', 'SessionNodeItem.tsx'),
  'utf8',
);

describe('background work indicator integration', () => {
  test('docks the banner above the composer with the queue and BTW panels, not in the transcript footer', () => {
    expect(chatInputSource).toContain('<BackgroundWorkBanner');
    expect(chatInputSource).toContain('hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasQueuedMessages}');
    expect(chatContainerSource).not.toContain('BackgroundWorkBanner');
    expect(bannerSource).toContain('<ComposerFloatingPanel');
  });

  test('lists subtasks from live child status and PTY jobs from session metadata', () => {
    expect(bannerSource).toContain('listRunningSubtasks(sessions, statuses, sessionId)');
    expect(bannerSource).toContain('state.session_status');
    expect(bannerSource).toContain('waiting.jobs.map(');
    expect(bannerSource).toContain('openSubagentSession(subtask.id, label)');
    expect(bannerSource).toContain('openPtyInspector(job.id, label)');
  });

  test('cleans up its live elapsed timer and uses only opacity animation', () => {
    expect(bannerSource).toContain('window.clearInterval(timer)');
    expect(bannerSource).toContain('animate-pulse');
    expect(bannerSource).not.toContain('animate-spin');
  });

  test('sidebar shows waiting only while live busy and retry status are absent', () => {
    expect(sidebarSource).toContain("const isStreaming = statusType === 'busy' || statusType === 'retry';");
    expect(sidebarSource).toContain('const isPtyWaiting = !isStreaming && ptyWaiting.count > 0;');
    expect(sidebarSource).toContain('const showStatusMarker = isStreaming || isPtyWaiting || showUnreadStatus;');
    expect(sidebarSource).toContain("? 'bg-[var(--status-warning)]'");
  });
});
