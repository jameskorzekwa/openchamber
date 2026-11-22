import React from 'react';
import { checkConnectedServerForUpdates } from '@/stores/useUpdateStore';
import type { UpdateInfo } from '@/lib/desktop';
import { getUpdateCheckErrorMessage } from '@/lib/updateCheckError';

type ConnectedServerUpdate = {
  info: UpdateInfo | null;
  checking: boolean;
  available: boolean;
  error: string | null;
};

const IDLE_SERVER_UPDATE: ConnectedServerUpdate = { info: null, checking: false, available: false, error: null };

export function useConnectedServerUpdate(enabled: boolean) {
  const [state, setState] = React.useState<ConnectedServerUpdate>(IDLE_SERVER_UPDATE);

  const check = React.useCallback(async () => {
    if (!enabled) return;
    setState((current) => ({ ...current, checking: true, error: null }));
    try {
      const info = await checkConnectedServerForUpdates();
      setState({ info, checking: false, available: info.available, error: null });
    } catch (error) {
      setState({
        info: null,
        checking: false,
        available: false,
        error: error instanceof Error ? getUpdateCheckErrorMessage(error) : String(error),
      });
    }
  }, [enabled]);

  return { ...state, check };
}
