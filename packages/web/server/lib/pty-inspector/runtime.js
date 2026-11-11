/**
 * PTY inspector: a read-only window onto the PTYs that the `opencode-pty`
 * OpenCode plugin owns (the agent's `pty_spawn` processes).
 *
 * The plugin keeps every PTY's output in the OpenCode process and serves it
 * from its own small web server (REST buffer reads plus a WebSocket that
 * streams `raw_data` per session). On bee2 that server listens on a fixed
 * loopback port; this module is the only way a browser reaches it:
 *
 *   GET /api/pty-inspector/status               -> { configured, url, reachable }
 *   GET /api/pty-inspector/sessions             -> plugin session list
 *   GET /api/pty-inspector/sessions/:id         -> one session record
 *   GET /api/pty-inspector/sessions/:id/buffer  -> { raw, byteLength }
 *   WS  /api/pty-inspector/ws?session=<id>      -> JSON frames, see below
 *
 * The WebSocket is deliberately narrower than the plugin's: the client sends
 * nothing the server forwards (the plugin's `spawn` and `input` messages are
 * never relayed), and the server forwards only `subscribed`, `readRawResponse`,
 * `raw_data`, `session_update`, and `error` frames for the requested session.
 * The plugin server also accepts spawn/input, so the configured URL is limited
 * to loopback hosts: a settings value must not turn an authenticated UI into a
 * way to drive arbitrary network hosts.
 *
 * Client frames:
 *   { t: 'subscribed', sessionId }
 *   { t: 'snapshot', sessionId, data }          // full buffer so far
 *   { t: 'data', sessionId, data }              // live output
 *   { t: 'session', session }                   // status change (exited, ...)
 *   { t: 'error', code, message, fatal }
 */
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

const PTY_INSPECTOR_WS_PATH = '/api/pty-inspector/ws';
export const DEFAULT_PTY_INSPECTOR_URL = 'http://127.0.0.1:4098';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const UPSTREAM_TIMEOUT_MS = 5000;

const sessionIdSchema = z.string().regex(/^pty_[A-Za-z0-9]{1,64}$/);
const configuredUrlSchema = z.string().trim().min(1);
const sessionSchema = z.object({ id: z.string() }).loose();
// Frames the plugin's /ws may send; anything else is dropped unforwarded.
const upstreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribed'), sessionId: z.string() }),
  z.object({ type: z.literal('unsubscribed'), sessionId: z.string() }),
  z.object({ type: z.literal('readRawResponse'), sessionId: z.string(), rawData: z.string() }),
  z.object({ type: z.literal('raw_data'), session: sessionSchema, rawData: z.string() }),
  z.object({ type: z.literal('session_update'), session: sessionSchema }),
  z.object({ type: z.literal('session_list'), sessions: z.array(sessionSchema) }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string().optional() }).loose() }),
]);

/**
 * Accepts only an http(s) origin on a loopback host. Returns the normalized
 * origin (no path, no trailing slash) or null.
 */
export const normalizePtyInspectorUrl = (value) => {
  const candidate = configuredUrlSchema.safeParse(value);
  if (!candidate.success) return null;
  let parsed;
  try {
    parsed = new URL(candidate.data);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password) return null;
  return parsed.origin;
};

const parseRequestUrl = (requestUrl) => {
  try {
    return new URL(requestUrl || '/', 'http://127.0.0.1');
  } catch {
    return null;
  }
};

const isValidSessionId = (value) => sessionIdSchema.safeParse(value).success;

const toWebSocketOrigin = (origin) => origin.replace(/^http/, 'ws');

export function createPtyInspectorRuntime({
  app,
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  resolveInspectorUrl,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
}) {
  const resolveUpstream = () => {
    const configured = resolveInspectorUrl();
    // Unset or blank means "the default"; a present but invalid value is a
    // misconfiguration the caller must surface, never silently the default.
    if (configured === undefined || configured === null || configured === '') return DEFAULT_PTY_INSPECTOR_URL;
    return normalizePtyInspectorUrl(configured);
  };

  const upstreamFetch = async (pathname) => {
    const origin = resolveUpstream();
    if (!origin) return { status: 0, body: null, error: 'invalid-url' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${origin}${pathname}`, { signal: controller.signal, headers: { accept: 'application/json' } });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, body, error: null };
    } catch (error) {
      return { status: 0, body: null, error: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  };

  const relayUpstream = async (res, pathname) => {
    const result = await upstreamFetch(pathname);
    if (result.error === 'invalid-url') { res.status(400).json({ error: 'PTY inspector URL must be a loopback http(s) origin' }); return; }
    if (result.error) { res.status(502).json({ error: 'PTY inspector is not reachable', reason: result.error }); return; }
    if (result.status === 404) { res.status(404).json({ error: 'PTY session not found' }); return; }
    if (result.status < 200 || result.status >= 300 || result.body === null) {
      res.status(502).json({ error: 'PTY inspector returned an unexpected response', status: result.status });
      return;
    }
    res.json(result.body);
  };

  app.get('/api/pty-inspector/status', async (_req, res) => {
    const origin = resolveUpstream();
    if (!origin) { res.json({ configured: false, url: null, reachable: false }); return; }
    const result = await upstreamFetch('/health');
    res.json({ configured: true, url: origin, reachable: result.error === null && result.status === 200 });
  });

  app.get('/api/pty-inspector/sessions', async (_req, res) => {
    await relayUpstream(res, '/api/sessions');
  });

  app.get('/api/pty-inspector/sessions/:id', async (req, res) => {
    if (!isValidSessionId(req.params.id)) { res.status(400).json({ error: 'Invalid PTY session id' }); return; }
    await relayUpstream(res, `/api/sessions/${encodeURIComponent(req.params.id)}`);
  });

  app.get('/api/pty-inspector/sessions/:id/buffer', async (req, res) => {
    if (!isValidSessionId(req.params.id)) { res.status(400).json({ error: 'Invalid PTY session id' }); return; }
    await relayUpstream(res, `/api/sessions/${encodeURIComponent(req.params.id)}/buffer/raw`);
  });

  const wsServer = new WebSocketServer({ noServer: true });

  const send = (socket, frame) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(frame)); } catch { /* closing */ }
  };

  wsServer.on('connection', (client, req) => {
    const sessionId = parseRequestUrl(req.url)?.searchParams.get('session') ?? '';
    if (!isValidSessionId(sessionId)) {
      send(client, { t: 'error', code: 'BAD_SESSION', message: 'Invalid PTY session id', fatal: true });
      client.close(1008, 'invalid session');
      return;
    }
    const origin = resolveUpstream();
    if (!origin) {
      send(client, { t: 'error', code: 'BAD_URL', message: 'PTY inspector URL must be a loopback http(s) origin', fatal: true });
      client.close(1011, 'inspector misconfigured');
      return;
    }

    let upstream;
    try {
      upstream = new WebSocketImpl(`${toWebSocketOrigin(origin)}/ws`);
    } catch {
      send(client, { t: 'error', code: 'UNREACHABLE', message: 'PTY inspector is not reachable', fatal: true });
      client.close(1011, 'inspector unreachable');
      return;
    }

    let closed = false;
    const closeBoth = (code, reason) => {
      if (closed) return;
      closed = true;
      try { upstream.close(); } catch { /* ignore */ }
      try { client.close(code, reason); } catch { /* ignore */ }
    };

    upstream.on('open', () => {
      upstream.send(JSON.stringify({ type: 'subscribe', sessionId }));
      upstream.send(JSON.stringify({ type: 'readRaw', sessionId }));
    });
    upstream.on('message', (data) => {
      let frame;
      try { frame = upstreamFrameSchema.safeParse(JSON.parse(data.toString())); } catch { return; }
      if (!frame.success) return;
      const message = frame.data;
      switch (message.type) {
        case 'subscribed':
          if (message.sessionId === sessionId) send(client, { t: 'subscribed', sessionId });
          return;
        case 'readRawResponse':
          if (message.sessionId === sessionId) send(client, { t: 'snapshot', sessionId, data: message.rawData });
          return;
        case 'raw_data':
          if (message.session.id === sessionId) send(client, { t: 'data', sessionId, data: message.rawData });
          return;
        case 'session_update':
          if (message.session.id === sessionId) send(client, { t: 'session', session: message.session });
          return;
        case 'error': {
          const text = message.error.message ?? 'PTY inspector error';
          const notFound = /not found/i.test(text);
          send(client, { t: 'error', code: notFound ? 'NOT_FOUND' : 'UPSTREAM', message: text, fatal: notFound });
          if (notFound) closeBoth(1000, 'session not found');
          return;
        }
        default:
          return;
      }
    });
    upstream.on('error', () => {
      send(client, { t: 'error', code: 'UNREACHABLE', message: 'PTY inspector is not reachable', fatal: true });
      closeBoth(1011, 'inspector unreachable');
    });
    upstream.on('close', () => closeBoth(1000, 'inspector closed'));

    // Read-only: client frames are never relayed upstream.
    client.on('message', () => {});
    client.on('close', () => closeBoth(1000, 'client closed'));
    client.on('error', () => closeBoth(1011, 'client error'));
  });

  const upgradeHandler = (req, socket, head) => {
    if (parseRequestUrl(req.url)?.pathname !== PTY_INSPECTOR_WS_PATH) return;
    const accept = () => {
      try {
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };
    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController.ensureSessionToken(req, null);
          if (!sessionToken) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        accept();
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };
    void handleUpgrade();
  };
  server.on('upgrade', upgradeHandler);

  const stop = () => {
    server.off('upgrade', upgradeHandler);
    for (const client of wsServer.clients) {
      try { client.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
  };

  return { stop, resolveUpstream };
}
