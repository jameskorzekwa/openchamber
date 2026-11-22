import React from 'react';
import { fetchOpenCodeUpgradeStatus, runOpenCodeUpgrade, type OpenCodeUpgradeStatus } from '@/components/update/openCodeUpgrade';

type OpenCodeUpgradePhase =
  | { kind: 'idle' }
  | { kind: 'upgrading' }
  | { kind: 'installed'; version: string | null }
  | { kind: 'failed'; error: string };

export function useOpenCodeUpgrade(failedFallback: string) {
  const [status, setStatus] = React.useState<OpenCodeUpgradeStatus | null>(null);
  const [phase, setPhase] = React.useState<OpenCodeUpgradePhase>({ kind: 'idle' });

  const refresh = React.useCallback(async (): Promise<OpenCodeUpgradeStatus | null> => {
    try {
      const next = await fetchOpenCodeUpgradeStatus();
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const upgrade = React.useCallback(async () => {
    setPhase({ kind: 'upgrading' });
    try {
      const version = await runOpenCodeUpgrade(failedFallback);
      setPhase({ kind: 'installed', version });
    } catch (error) {
      setPhase({ kind: 'failed', error: error instanceof Error ? error.message : failedFallback });
    }
  }, [failedFallback]);

  const reloadAfterUpgrade = React.useCallback(async (reload: () => Promise<void>) => {
    await reload().catch(() => undefined);
    const next = await refresh();
    if (!next?.currentVersion) return;
    setPhase((current) => {
      if (current.kind !== 'installed') return current;
      if (current.version && current.version.replace(/^v/, '') !== next.currentVersion) return current;
      return { kind: 'idle' };
    });
  }, [refresh]);

  return { status, phase, refresh, upgrade, reloadAfterUpgrade };
}
