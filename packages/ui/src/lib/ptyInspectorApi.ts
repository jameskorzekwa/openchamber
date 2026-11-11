import { z } from 'zod';

import { openRuntimeWebSocket } from './relay/runtime-socket';
import type { RelayTunnelSocketMessageEvent, RelayTunnelWebSocket } from './relay/tunnel-client';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { refreshRuntimeUrlAuthToken } from './runtime-auth';

/**
 * Read-only view of a PTY the agent spawned through the opencode-pty plugin.
 * The OpenChamber server relays the plugin's inspector (`/api/pty-inspector/*`);
 * this module owns the wire contract on the client side so the pane only sees
 * parsed events.
 */

const PTY_INSPECTOR_WS_PATH = '/api/pty-inspector/ws';

const ptySessionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  status: z.enum(['running', 'exited', 'killed', 'error']).catch('running'),
  exitCode: z.number().nullable().optional(),
  pid: z.number().optional(),
  createdAt: z.string().optional(),
  lineCount: z.number().optional(),
});

export type PtySession = z.infer<typeof ptySessionSchema>;

const frameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribed'), sessionId: z.string() }),
  z.object({ t: z.literal('snapshot'), sessionId: z.string(), data: z.string() }),
  z.object({ t: z.literal('data'), sessionId: z.string(), data: z.string() }),
  z.object({ t: z.literal('session'), session: ptySessionSchema }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string(), fatal: z.boolean() }),
]);

type PtyInspectorFrame = z.infer<typeof frameSchema>;

export type PtyInspectorEvent =
  | PtyInspectorFrame
  /** The socket closed without a fatal frame; the caller decides whether to retry. */
  | { t: 'closed' };

export async function fetchPtySession(ptyId: string): Promise<PtySession | null> {
  const response = await runtimeFetch(`/api/pty-inspector/sessions/${encodeURIComponent(ptyId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PTY session lookup failed (${response.status})`);
  return ptySessionSchema.parse(await response.json());
}

export type PtyInspectorConnection = {
  close: () => void;
};

type OpenSocket = (url: string) => RelayTunnelWebSocket;
type ResolveSocketUrl = (ptyId: string) => string;

const resolveSocketUrl: ResolveSocketUrl = (ptyId) => getRuntimeUrlResolver().websocket(PTY_INSPECTOR_WS_PATH, { session: ptyId });

/**
 * Opens one inspector socket for `ptyId` and reports parsed frames. The caller
 * receives `snapshot` once (the backlog) and `data` as output arrives; a
 * `session` frame carries status changes such as the process exiting.
 */
export function connectPtyInspector(
  ptyId: string,
  onEvent: (event: PtyInspectorEvent) => void,
  dependencies: { refreshAuth?: () => Promise<string | void>; openSocket?: OpenSocket; resolveUrl?: ResolveSocketUrl } = {},
): PtyInspectorConnection {
  const refreshAuth = dependencies.refreshAuth ?? refreshRuntimeUrlAuthToken;
  const openSocket = dependencies.openSocket
    ?? ((url: string) => openRuntimeWebSocket(url));
  let socket: RelayTunnelWebSocket | null = null;
  let closed = false;

  void (async () => {
    try {
      // WebSockets cannot carry the bearer header; the resolver appends the
      // short-lived URL token minted here.
      await refreshAuth();
    } catch {
      // A failed mint still lets a direct same-origin connection try.
    }
    if (closed) return;
    try {
      socket = openSocket((dependencies.resolveUrl ?? resolveSocketUrl)(ptyId));
    } catch {
      onEvent({ t: 'error', code: 'UNREACHABLE', message: 'PTY inspector is not reachable', fatal: true });
      return;
    }
    socket.onmessage = (event: RelayTunnelSocketMessageEvent) => {
      if (closed) return;
      const text = z.string().safeParse(event.data);
      if (!text.success) return;
      let frame;
      try { frame = frameSchema.safeParse(JSON.parse(text.data)); } catch { return; }
      if (frame.success) onEvent(frame.data);
    };
    socket.onerror = () => {
      // The close event that follows carries the outcome.
    };
    socket.onclose = () => {
      if (closed) return;
      onEvent({ t: 'closed' });
    };
  })();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      try { socket?.close(); } catch { /* already closed */ }
    },
  };
}
