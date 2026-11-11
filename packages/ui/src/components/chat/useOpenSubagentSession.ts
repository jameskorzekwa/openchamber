import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';

/**
 * Opens a child (subagent) session the way the transcript's Task tool does:
 * surfaces that cannot host an embedded context panel navigate to the child in
 * place; everywhere else it opens as a read-only side-panel tab.
 */
export function useOpenSubagentSession(directory: string | null): (childId: string, label: string) => void {
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

  return React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isEmbeddedSessionChat() || isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, openContextPanelTab, setCurrentSession]);
}
