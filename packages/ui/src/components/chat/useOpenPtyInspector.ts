import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';

/**
 * Opens the read-only output panel for a PTY the agent spawned. The panel is
 * a context-panel tab, so it exists only where the context panel does: web,
 * desktop and VS Code. The hosted and native mobile shells and the embedded
 * session-chat iframe have no panel to dock it in, so the hook returns null
 * and the row stays plain text there.
 */
export function useOpenPtyInspector(directory: string | null): ((ptyId: string, label: string) => void) | null {
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const unsupported = isMobile || isEmbeddedSessionChat();

  return React.useMemo(() => {
    if (!directory || unsupported) return null;
    return (ptyId: string, label: string) => {
      openContextPanelTab(directory, {
        mode: 'pty',
        dedupeKey: ptyId,
        label,
        readOnly: true,
      });
    };
  }, [directory, openContextPanelTab, unsupported]);
}
