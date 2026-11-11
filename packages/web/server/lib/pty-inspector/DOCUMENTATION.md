# PTY inspector module

A read-only window onto the PTYs the agent spawns through the `opencode-pty`
OpenCode plugin (`pty_spawn`). The plugin keeps each PTY's output inside the
OpenCode process and serves it from its own small web server: REST reads of
the buffer and a WebSocket that streams `raw_data` per session. That server
also accepts `spawn` and `input`, so it binds to loopback and this module is
the only path from a browser to it.

## Routes

| Route | Behavior |
|---|---|
| `GET /api/pty-inspector/status` | `{ configured, url, reachable }` — `configured: false` when the setting is not a loopback origin. |
| `GET /api/pty-inspector/sessions` | The plugin's session list, relayed. |
| `GET /api/pty-inspector/sessions/:id` | One session record; 404 when the plugin no longer has it. |
| `GET /api/pty-inspector/sessions/:id/buffer` | `{ raw, byteLength }` — the raw (ANSI) buffer. |
| `WS /api/pty-inspector/ws?session=<id>` | One upstream subscription per client socket. |

Session ids must match `pty_[A-Za-z0-9]+`; anything else is 400 / `BAD_SESSION`.
Relay failures are 502 with a `reason` (`unreachable`, `timeout`); an invalid
setting is 400 and never contacted.

All routes sit behind the `/api` UI-auth gate like every other OpenChamber
route. The WebSocket upgrade checks the UI session token and the request origin
the same way the terminal and dictation sockets do, and the path is listed in
the three WebSocket allowlists (`relay/tunnel-host.js`, `ui-auth/ui-auth.js`
`isUrlAuthWebSocketPath`, `realtime-proxy.js`) so it works over the relay, with
URL-token auth, and through the desktop realtime proxy.

## Socket contract

The server sends `subscribe` and `readRaw` upstream once, then forwards only
frames for the requested session, re-shaped:

```
{ t: 'subscribed', sessionId }
{ t: 'snapshot',   sessionId, data }   // the buffer so far (readRawResponse)
{ t: 'data',       sessionId, data }   // live output (raw_data)
{ t: 'session',    session }           // status change (session_update)
{ t: 'error',      code, message, fatal }
```

Client frames are read and discarded: nothing the browser sends reaches the
plugin, which is what keeps this surface read-only even though the upstream
protocol can spawn processes and type into them. An upstream `not found` error
closes the socket with `NOT_FOUND` (fatal); an unreachable upstream closes with
`UNREACHABLE`.

## Configuration

`ptyInspectorUrl` (instance-scoped setting, `settings.json`) names the plugin
server; unset or blank means `http://127.0.0.1:4098`. `normalizePtyInspectorUrl`
accepts only `http(s)` origins on `127.0.0.1`, `localhost`, or `[::1]` without
credentials; the settings sanitizer applies the same rule on write, so a saved
value is either a loopback origin or empty. The value is read on every request,
so a settings save takes effect without a restart.

The plugin only starts its server from a slash command by default; the
OpenChamber deployment is expected to run a small OpenCode plugin that starts
it at boot on the configured port (bee2: `config/opencode/plugins/pty-inspector.ts`).

## Client

`packages/ui/src/lib/ptyInspectorApi.ts` owns the wire contract
(`connectPtyInspector`, `fetchPtySession`), opening the socket through
`openRuntimeWebSocket` after minting the URL token. The pane
(`components/pty-inspector/PtyInspectorPane.tsx`) feeds snapshot and data
frames into the Ghostty `TerminalViewport` as read-only chunks and derives its
status from `ptyInspectorState.ts`.
