export function waitForDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(elapsed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function requestDeadline(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  const timer = setTimeout(abort, milliseconds);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
