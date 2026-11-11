import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createPtyInspectorRuntime, normalizePtyInspectorUrl, DEFAULT_PTY_INSPECTOR_URL } from './runtime.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

/** A stand-in for the opencode-pty plugin's web server: REST + the /ws protocol. */
async function createFakeInspector({ sessions = [], buffers = {} } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/health') return send(200, { status: 'healthy' });
    if (url.pathname === '/api/sessions') return send(200, sessions);
    const buffer = /^\/api\/sessions\/([^/]+)\/buffer\/raw$/.exec(url.pathname);
    if (buffer) {
      const raw = buffers[buffer[1]];
      return raw === undefined ? send(404, { error: 'not found' }) : send(200, { raw, byteLength: raw.length });
    }
    const one = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const session = sessions.find((entry) => entry.id === one[1]);
      return session ? send(200, session) : send(404, { error: 'not found' });
    }
    send(404, { error: 'not found' });
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();
  wss.on('connection', (socket) => {
    clients.add(socket);
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.type === 'subscribe') {
        if (!sessions.some((entry) => entry.id === message.sessionId)) {
          socket.send(JSON.stringify({ type: 'error', error: { message: `Session ${message.sessionId} not found` } }));
        } else {
          socket.send(JSON.stringify({ type: 'subscribed', sessionId: message.sessionId }));
        }
      }
      if (message.type === 'readRaw') {
        socket.send(JSON.stringify({ type: 'readRawResponse', sessionId: message.sessionId, rawData: buffers[message.sessionId] ?? '' }));
      }
    });
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    publish: (frame) => { for (const socket of clients) socket.send(JSON.stringify(frame)); },
    stop: async () => { for (const socket of clients) socket.terminate(); await close(server); },
  };
}

function createApp() {
  const routes = [];
  const app = {
    get(path, handler) {
      const params = [];
      const pattern = new RegExp(`^${path.replace(/:([^/]+)/g, (_, name) => { params.push(name); return '([^/]+)'; })}$`);
      routes.push({ pattern, params, handler });
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = routes.find((entry) => entry.pattern.test(url.pathname));
    if (!route) { res.writeHead(404); res.end(); return; }
    const match = route.pattern.exec(url.pathname);
    const response = {
      statusCode: 200, body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await route.handler({ url: req.url, params: Object.fromEntries(route.params.map((name, index) => [name, match[index + 1]])) }, response);
    res.writeHead(response.statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  return { app, server };
}

async function createRuntime(options = {}) {
  const { app, server } = createApp();
  const rejected = [];
  const runtime = createPtyInspectorRuntime({
    app,
    server,
    uiAuthController: options.uiAuthController ?? { enabled: false },
    isRequestOriginAllowed: options.isRequestOriginAllowed ?? (() => true),
    rejectWebSocketUpgrade: (socket, code, message) => { rejected.push({ code, message }); socket.destroy(); },
    resolveInspectorUrl: options.resolveInspectorUrl ?? (() => undefined),
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const getJson = async (path) => { const response = await fetch(`${origin}${path}`); return { status: response.status, body: await response.json() }; };
  const openSocket = async (query) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/pty-inspector/ws${query}`);
    const frames = [];
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    // A refused upgrade surfaces as an error before open; the test reads the rejection list.
    socket.on('error', () => {});
    await new Promise((resolve) => { socket.once('open', resolve); socket.once('error', resolve); socket.once('close', resolve); });
    const next = async (type) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const index = frames.findIndex((frame) => frame.t === type);
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${type}; saw ${JSON.stringify(frames)}`);
    };
    return { socket, frames, next, closed };
  };
  return { runtime, origin, getJson, openSocket, rejected, stop: async () => { runtime.stop(); await close(server); } };
}

describe('normalizePtyInspectorUrl', () => {
  it('accepts loopback http origins only', () => {
    expect(normalizePtyInspectorUrl('http://127.0.0.1:4098/')).toBe('http://127.0.0.1:4098');
    expect(normalizePtyInspectorUrl(' http://localhost:4098/api ')).toBe('http://localhost:4098');
    expect(normalizePtyInspectorUrl('http://[::1]:4098')).toBe('http://[::1]:4098');
    expect(normalizePtyInspectorUrl('http://192.168.0.5:4098')).toBeNull();
    expect(normalizePtyInspectorUrl('http://bee2.local:4098')).toBeNull();
    expect(normalizePtyInspectorUrl('ws://127.0.0.1:4098')).toBeNull();
    expect(normalizePtyInspectorUrl('http://user:pw@127.0.0.1:4098')).toBeNull();
    expect(normalizePtyInspectorUrl('')).toBeNull();
    expect(normalizePtyInspectorUrl(42)).toBeNull();
  });
});

describe('pty inspector runtime', () => {
  it('falls back to the default URL when no setting is stored', async () => {
    const harness = await createRuntime();
    try {
      expect(harness.runtime.resolveUpstream()).toBe(DEFAULT_PTY_INSPECTOR_URL);
    } finally { await harness.stop(); }
  });

  it('reports status, relays session and buffer reads, and maps upstream 404s', async () => {
    const inspector = await createFakeInspector({
      sessions: [{ id: 'pty_abc123', title: 'build', status: 'running' }],
      buffers: { pty_abc123: 'hello\r\nworld\r\n' },
    });
    const harness = await createRuntime({ resolveInspectorUrl: () => inspector.origin });
    try {
      expect(await harness.getJson('/api/pty-inspector/status')).toEqual({ status: 200, body: { configured: true, url: inspector.origin, reachable: true } });
      expect((await harness.getJson('/api/pty-inspector/sessions')).body).toEqual([{ id: 'pty_abc123', title: 'build', status: 'running' }]);
      expect((await harness.getJson('/api/pty-inspector/sessions/pty_abc123')).body.title).toBe('build');
      expect((await harness.getJson('/api/pty-inspector/sessions/pty_abc123/buffer')).body).toEqual({ raw: 'hello\r\nworld\r\n', byteLength: 14 });
      expect((await harness.getJson('/api/pty-inspector/sessions/pty_missing')).status).toBe(404);
      expect((await harness.getJson('/api/pty-inspector/sessions/not-a-pty-id/buffer')).status).toBe(400);
    } finally { await harness.stop(); await inspector.stop(); }
  });

  it('rejects a non-loopback setting without contacting it', async () => {
    const harness = await createRuntime({ resolveInspectorUrl: () => 'http://192.168.0.5:4098' });
    try {
      expect(await harness.getJson('/api/pty-inspector/status')).toEqual({ status: 200, body: { configured: false, url: null, reachable: false } });
      expect((await harness.getJson('/api/pty-inspector/sessions')).status).toBe(400);
      const { next, closed } = await harness.openSocket('?session=pty_abc123');
      expect((await next('error')).code).toBe('BAD_URL');
      expect(await closed).toBe(1011);
    } finally { await harness.stop(); }
  });

  it('answers 502 when the inspector is down', async () => {
    const dead = http.createServer(); const port = await listen(dead); await close(dead);
    const harness = await createRuntime({ resolveInspectorUrl: () => `http://127.0.0.1:${port}` });
    try {
      expect((await harness.getJson('/api/pty-inspector/status')).body.reachable).toBe(false);
      const result = await harness.getJson('/api/pty-inspector/sessions');
      expect(result.status).toBe(502);
      expect(result.body.reason).toBe('unreachable');
      const { next, closed } = await harness.openSocket('?session=pty_abc123');
      expect((await next('error')).code).toBe('UNREACHABLE');
      expect(await closed).toBe(1011);
    } finally { await harness.stop(); }
  });

  it('streams snapshot then live data for one session and never relays client frames', async () => {
    const inspector = await createFakeInspector({
      sessions: [{ id: 'pty_abc123', title: 'build', status: 'running' }, { id: 'pty_other', title: 'other', status: 'running' }],
      buffers: { pty_abc123: 'backlog\r\n' },
    });
    const harness = await createRuntime({ resolveInspectorUrl: () => inspector.origin });
    try {
      const { socket, next, frames } = await harness.openSocket('?session=pty_abc123');
      expect(await next('subscribed')).toEqual({ t: 'subscribed', sessionId: 'pty_abc123' });
      expect(await next('snapshot')).toEqual({ t: 'snapshot', sessionId: 'pty_abc123', data: 'backlog\r\n' });
      inspector.publish({ type: 'raw_data', session: { id: 'pty_other' }, rawData: 'leak\r\n' });
      inspector.publish({ type: 'raw_data', session: { id: 'pty_abc123' }, rawData: 'tick 1\r\n' });
      expect(await next('data')).toEqual({ t: 'data', sessionId: 'pty_abc123', data: 'tick 1\r\n' });
      inspector.publish({ type: 'session_update', session: { id: 'pty_abc123', status: 'exited', exitCode: 0 } });
      expect((await next('session')).session.status).toBe('exited');
      socket.send(JSON.stringify({ type: 'input', sessionId: 'pty_abc123', data: 'rm -rf /\n' }));
      socket.send(JSON.stringify({ type: 'spawn', command: 'sh' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(inspector.received.map((message) => message.type)).toEqual(['subscribe', 'readRaw']);
      expect(frames.some((frame) => frame.data === 'leak\r\n')).toBe(false);
      socket.close();
    } finally { await harness.stop(); await inspector.stop(); }
  });

  it('closes with a fatal error for an unknown session', async () => {
    const inspector = await createFakeInspector({ sessions: [] });
    const harness = await createRuntime({ resolveInspectorUrl: () => inspector.origin });
    try {
      const { next, closed } = await harness.openSocket('?session=pty_missing1');
      const error = await next('error');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.fatal).toBe(true);
      expect(await closed).toBe(1000);
      const bad = await harness.openSocket('?session=../etc');
      expect((await bad.next('error')).code).toBe('BAD_SESSION');
    } finally { await harness.stop(); await inspector.stop(); }
  });

  it('requires a UI session token and a trusted origin when UI auth is enabled', async () => {
    const harness = await createRuntime({
      uiAuthController: { enabled: true, ensureSessionToken: async () => null },
      resolveInspectorUrl: () => 'http://127.0.0.1:1',
    });
    try {
      const { closed } = await harness.openSocket('?session=pty_abc123');
      await closed;
      expect(harness.rejected).toEqual([{ code: 401, message: 'UI authentication required' }]);
    } finally { await harness.stop(); }
  });
});
