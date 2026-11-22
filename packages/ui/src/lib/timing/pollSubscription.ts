export function pollSubscription(
  poll: (signal: AbortSignal) => Promise<number | null>,
  initialDelay = 0,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    if (controller.signal.aborted) return;
    const nextDelay = await poll(controller.signal);
    if (!controller.signal.aborted && nextDelay !== null) timer = setTimeout(() => { void read(); }, nextDelay);
  };
  if (initialDelay === 0) void read();
  else timer = setTimeout(() => { void read(); }, initialDelay);
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
