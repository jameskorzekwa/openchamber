import { pollSubscription } from '@/lib/timing/pollSubscription';
import type { isOpencodeNotFound } from '@/lib/opencode/client';
import type { TerminalChunk } from '@/stores/useTerminalStore';
import { reduceShellOutputEvent, toTerminalText, type ShellOutputEvent, type ShellOutputState } from './shellOutputState';

interface ShellPresence {
  running: boolean;
  ended: Extract<ShellOutputEvent, { t: 'ended' }> | null;
}

interface ShellOutputSource {
  read: (cursor: number | undefined) => Promise<{ output: string; cursor: number; skipped?: boolean }>;
  isNotFound: typeof isOpencodeNotFound;
  getPresence: () => ShellPresence;
  subscribePresence: (notify: () => void) => () => void;
  omittedLabel: string;
}

interface ShellOutputSnapshot { state: ShellOutputState; chunks: TerminalChunk[] }

export function createShellOutputSubscription(source: ShellOutputSource) {
  let snapshot: ShellOutputSnapshot = { state: { kind: 'loading' }, chunks: [] };
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  let cursor: number | undefined;
  let nextChunkId = 1;
  let delay = 1_000;
  let lastPresence: ShellPresence | null = null;
  const publish = (event: ShellOutputEvent, text = '') => {
    const state = reduceShellOutputEvent(snapshot.state, event);
    let chunks = snapshot.chunks;
    if (text) {
      const data = toTerminalText(text);
      chunks = [...chunks, { id: nextChunkId++, data, byteLength: new TextEncoder().encode(data).byteLength }];
    }
    if (state === snapshot.state && chunks === snapshot.chunks) return;
    snapshot = { state, chunks };
    listeners.forEach((notify) => notify());
  };
  const syncPresence = () => {
    const presence = source.getPresence();
    if (presence.running && !lastPresence?.running) publish({ t: 'running' });
    if (presence.ended && (presence.ended.status !== lastPresence?.ended?.status || presence.ended.exit !== lastPresence?.ended?.exit)) publish(presence.ended);
    lastPresence = presence;
  };
  const read = async (signal: AbortSignal) => {
    let brought = false;
    try {
      const page = await source.read(cursor);
      if (signal.aborted) return null;
      const first = cursor === undefined;
      cursor = page.cursor;
      let text = page.output;
      if (first && page.skipped) {
        const lineStart = text.indexOf('\n');
        text = lineStart === -1 ? '' : text.slice(lineStart + 1);
        if (text) text = `${source.omittedLabel}\n${text}`;
      }
      brought = text.length > 0;
      publish({ t: 'page' }, text);
      delay = first || brought ? 1_000 : Math.min(delay * 2, 4_000);
    } catch (error) {
      if (signal.aborted) return null;
      if (source.isNotFound(error)) {
        publish({ t: 'not-found' });
        return null;
      }
    }
    return source.getPresence().ended && !brought ? null : delay;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      if (listeners.size === 1) {
        const unsubscribe = source.subscribePresence(syncPresence);
        syncPresence();
        const cancel = pollSubscription(read);
        stop = () => { cancel(); unsubscribe(); };
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          stop?.();
          stop = null;
        }
      };
    },
  };
}
