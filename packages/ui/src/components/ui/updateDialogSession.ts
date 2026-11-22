import type { WebUpdateInstallationStatus } from '@/components/update/web-update-status';
import { installWebUpdate, waitForUpdateApplied } from '@/lib/web-update';
import { pollSubscription } from '@/lib/timing/pollSubscription';

interface InstallationStore {
  getState: () => {
    installation: WebUpdateInstallationStatus | null;
    installationCompleted: boolean;
    error: string | null;
    refreshInstallation: () => Promise<WebUpdateInstallationStatus | null>;
    startWebUpdate: (runtime: 'web') => Promise<boolean>;
  };
  subscribe: (notify: () => void) => () => void;
}

interface DialogSnapshot {
  phase: WebUpdateInstallationStatus['state'];
  error: string | null;
}

export function createUpdateDialogSession(options: {
  open: boolean;
  web: boolean;
  electron: boolean;
  store: InstallationStore;
  reload: () => void;
  install?: typeof installWebUpdate;
  waitForApplied?: typeof waitForUpdateApplied;
}) {
  const listeners = new Set<() => void>();
  let snapshot: DialogSnapshot = { phase: 'available', error: null };
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let cancelReload: (() => void) | null = null;
  let verification: AbortController | null = null;
  const publish = (next: DialogSnapshot) => {
    if (next.phase === snapshot.phase && next.error === snapshot.error) return;
    if (next.phase !== 'installed') {
      cancelReload?.();
      cancelReload = null;
    }
    snapshot = next;
    listeners.forEach((notify) => notify());
  };
  const reloadWhenInstalled = () => {
    if (!options.web || snapshot.phase !== 'installed' || cancelReload || listeners.size === 0) return;
    const owner = generation;
    cancelReload = pollSubscription(async (signal) => {
      if (!signal.aborted && owner === generation && snapshot.phase === 'installed' && listeners.size > 0) options.reload();
      return null;
    }, 500);
  };
  const readInstallation = () => {
    if (options.electron) return;
    const { installation, installationCompleted, error } = options.store.getState();
    publish({
      phase: installation?.state === 'installed' && !installationCompleted ? 'available' : installation?.state ?? 'available',
      error: installation?.error ?? error,
    });
    reloadWhenInstalled();
  };
  readInstallation();

  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      if (listeners.size === 1) {
        unsubscribe = options.store.subscribe(readInstallation);
        readInstallation();
        reloadWhenInstalled();
        if (options.open && options.web && !options.electron) void options.store.getState().refreshInstallation();
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          generation += 1;
          cancelReload?.();
          cancelReload = null;
          verification?.abort();
          verification = null;
          unsubscribe?.();
          unsubscribe = null;
        }
      };
    },
    start: async (currentVersion: string | undefined, messages: { failed: string; takingLonger: string }) => {
      if (!options.web) return;
      if (!options.electron) {
        await options.store.getState().startWebUpdate('web');
        return;
      }
      verification?.abort();
      verification = new AbortController();
      const signal = verification.signal;
      const owner = ++generation;
      publish({ phase: 'installing', error: null });
      const result = await (options.install ?? installWebUpdate)();
      if (owner !== generation) return;
      if (!result.success || result.target.owner !== 'electron') {
        publish({ phase: 'failed', error: !result.success && result.error ? result.error : messages.failed });
        return;
      }
      publish({ phase: 'restarting', error: null });
      const applied = await (options.waitForApplied ?? waitForUpdateApplied)(result.target, currentVersion, { signal });
      if (owner !== generation || applied.status === 'cancelled') return;
      publish(applied.status === 'applied'
        ? { phase: 'installed', error: null }
        : { phase: 'failed', error: applied.status === 'failed' ? applied.error : messages.takingLonger });
      reloadWhenInstalled();
    },
  };
}
