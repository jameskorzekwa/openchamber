import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const chatContainerSource = readFileSync(join(testDirectory, '..', 'ChatContainer.tsx'), 'utf8');
const bannerSource = readFileSync(join(testDirectory, '..', 'BackgroundWorkBanner.tsx'), 'utf8');
const sidebarSource = readFileSync(
  join(testDirectory, '..', '..', 'session', 'sidebar', 'sessions', 'SessionNodeItem.tsx'),
  'utf8',
);

describe('background work indicator integration', () => {
  test('mounts the banner directly after the session error notice in the list footer', () => {
    const errorNoticeIndex = chatContainerSource.indexOf('<SessionErrorNotice');
    const bannerIndex = chatContainerSource.indexOf('<BackgroundWorkBanner', errorNoticeIndex);
    const footerSpacerIndex = chatContainerSource.indexOf('className="flex-shrink-0"', bannerIndex);

    expect(errorNoticeIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeGreaterThan(errorNoticeIndex);
    expect(footerSpacerIndex).toBeGreaterThan(bannerIndex);
  });

  test('the viewport memo skips re-renders unless a PTY job row would change', () => {
    expect(chatContainerSource).toContain(
      'arePtyWaitingStatesEqual(getPtyWaitingState(prev.currentSession), getPtyWaitingState(next.currentSession))',
    );
  });

  test('lists subtasks from live child status and PTY jobs from session metadata', () => {
    expect(bannerSource).toContain('listRunningSubtasks(sessions, statuses, sessionId)');
    expect(bannerSource).toContain('state.session_status');
    expect(bannerSource).toContain('waiting.jobs.map(');
    expect(bannerSource).toContain('openSubagentSession(subtask.id, label)');
  });

  test('cleans up its live elapsed timer and uses only opacity animation', () => {
    expect(bannerSource).toContain('window.clearInterval(timer)');
    expect(bannerSource).toContain('animate-pulse');
    expect(bannerSource).not.toContain('animate-spin');
  });

  test('sidebar shows waiting only while upstream reports no active turn or background work', () => {
    expect(sidebarSource).toContain('const turnActivity = useSessionTurnActivity(session.id);');
    expect(sidebarSource).toContain('const isStreaming = turnActivity !== null;');
    expect(sidebarSource).toContain('const isPtyWaiting = !isStreaming && ptyWaiting.count > 0;');
    expect(sidebarSource).toContain('const showStatusMarker = isStreaming || isPtyWaiting || showUnreadStatus;');
    expect(sidebarSource).toContain('bg-[var(--status-warning)]');
  });
});
