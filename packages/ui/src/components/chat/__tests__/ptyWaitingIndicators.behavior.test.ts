import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const chatContainerSource = readFileSync(join(testDirectory, '..', 'ChatContainer.tsx'), 'utf8');
const bannerSource = readFileSync(join(testDirectory, '..', 'PtyWaitingBanner.tsx'), 'utf8');
const sidebarSource = readFileSync(
  join(testDirectory, '..', '..', 'session', 'sidebar', 'sessions', 'SessionNodeItem.tsx'),
  'utf8',
);

describe('PTY waiting indicator integration', () => {
  test('mounts the focused banner directly after the session recap in the list footer', () => {
    const recapIndex = chatContainerSource.indexOf('<SessionRecapNote');
    const bannerIndex = chatContainerSource.indexOf('<PtyWaitingBanner', recapIndex);
    const footerSpacerIndex = chatContainerSource.indexOf('className="flex-shrink-0"', bannerIndex);

    expect(recapIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeGreaterThan(recapIndex);
    expect(footerSpacerIndex).toBeGreaterThan(bannerIndex);
  });

  test('cleans up its live elapsed timer and uses only opacity animation', () => {
    expect(bannerSource).toContain('window.clearInterval(timer)');
    expect(bannerSource).toContain('animate-pulse');
    expect(bannerSource).not.toContain('animate-spin');
  });

  test('shows waiting only while live busy and retry status are absent', () => {
    expect(sidebarSource).toContain("const isStreaming = statusType === 'busy' || statusType === 'retry';");
    expect(sidebarSource).toContain('const isPtyWaiting = !isStreaming && ptyWaiting.count > 0;');
    expect(sidebarSource).toContain('const showStatusMarker = isStreaming || isPtyWaiting || showUnreadStatus;');
    expect(sidebarSource).toContain("? 'bg-[var(--status-warning)]'");
  });
});
