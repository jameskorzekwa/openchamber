import React from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Opens the read-only output panel for a command the agent left running in
 * the background (an OpenCode `shell` call with `background: true`). The
 * panel is a context-panel tab, so it exists only where the side panel does;
 * mobile and VS Code have none and get null, so the row offers no button.
 */
export function useOpenShellOutput(directory: string | null): ((shellID: string, shellDirectory: string, label: string) => void) | null {
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const unsupported = isMobile || isVSCodeRuntime();

  return React.useMemo(() => {
    if (!directory || unsupported) return null;
    return (shellID: string, shellDirectory: string, label: string) => {
      openContextPanelTab(directory, {
        mode: 'pty',
        dedupeKey: shellID,
        targetDirectory: shellDirectory,
        label,
        readOnly: true,
      });
    };
  }, [directory, openContextPanelTab, unsupported]);
}
