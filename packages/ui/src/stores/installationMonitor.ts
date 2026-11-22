import { pollSubscription } from '@/lib/timing/pollSubscription';
import type { WebUpdateInstallationStatus } from '@/components/update/web-update-status';

export const isInstallationActive = (status: WebUpdateInstallationStatus | null) =>
  status?.state === 'downloading' || status?.state === 'installing' || status?.state === 'restarting';

export function createInstallationMonitor(dependencies: {
  read: (signal: AbortSignal) => Promise<WebUpdateInstallationStatus | null>;
  current: () => WebUpdateInstallationStatus | null;
  publish: (status: WebUpdateInstallationStatus) => void;
}) {
  let revision = 0;
  let cancelPolling: (() => void) | null = null;
  let pending: Promise<WebUpdateInstallationStatus | null> | null = null;
  let request: AbortController | null = null;

  const refresh = (): Promise<WebUpdateInstallationStatus | null> => {
    if (pending) return pending;
    const capturedRevision = revision;
    const controller = new AbortController();
    request = controller;
    const operation = (async () => {
      try {
        const status = await dependencies.read(controller.signal);
        if (!controller.signal.aborted && revision === capturedRevision && status) dependencies.publish(status);
      } catch {
        void 0;
      }
      return dependencies.current();
    })();
    pending = operation;
    void operation.finally(() => {
      if (pending === operation) {
        pending = null;
        request = null;
      }
    });
    return operation;
  };

  return {
    refresh,
    observe: (status: WebUpdateInstallationStatus | null) => {
      revision += 1;
      if (isInstallationActive(status)) {
        if (!cancelPolling) {
          cancelPolling = pollSubscription(async () => {
            await refresh();
            return isInstallationActive(dependencies.current()) ? 2_000 : null;
          }, 2_000);
        }
      } else {
        cancelPolling?.();
        cancelPolling = null;
      }
    },
    reset: () => {
      revision += 1;
      cancelPolling?.();
      cancelPolling = null;
      request?.abort();
      request = null;
      pending = null;
    },
  };
}
