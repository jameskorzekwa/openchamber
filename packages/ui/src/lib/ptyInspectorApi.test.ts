import { describe, expect, test } from 'bun:test';

import { connectPtyInspector, type PtyInspectorEvent } from './ptyInspectorApi';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';

type FakeSocket = RelayTunnelWebSocket & {
  url: string;
  closed: boolean;
  emit: (payload: string) => void;
};

const createFakeSocket = (url: string): FakeSocket => {
  const socket: FakeSocket = {
    url,
    closed: false,
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => { socket.closed = true; socket.onclose?.({ code: 1000, reason: '' }); },
    emit: (payload) => socket.onmessage?.({ data: payload }),
  };
  return socket;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('connectPtyInspector', () => {
  test('mints the URL token, connects with the session query, and reports parsed frames only', async () => {
    const events: PtyInspectorEvent[] = [];
    let minted = 0;
    const sockets: FakeSocket[] = [];
    const connection = connectPtyInspector('pty_abc123', (event) => events.push(event), {
      refreshAuth: async () => { minted += 1; },
      resolveUrl: (ptyId) => `ws://runtime.test/api/pty-inspector/ws?session=${ptyId}`,
      openSocket: (url) => { const socket = createFakeSocket(url); sockets.push(socket); return socket; },
    });
    await flush();
    expect(minted).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toContain('/api/pty-inspector/ws');
    expect(sockets[0].url).toContain('session=pty_abc123');

    sockets[0].emit(JSON.stringify({ t: 'subscribed', sessionId: 'pty_abc123' }));
    sockets[0].emit(JSON.stringify({ t: 'snapshot', sessionId: 'pty_abc123', data: 'hi\r\n' }));
    sockets[0].emit('not json');
    sockets[0].emit(JSON.stringify({ t: 'bogus' }));
    sockets[0].emit(JSON.stringify({ t: 'data', sessionId: 'pty_abc123', data: 'more\r\n' }));
    sockets[0].emit(JSON.stringify({ t: 'session', session: { id: 'pty_abc123', status: 'exited', exitCode: 0 } }));
    sockets[0].emit(JSON.stringify({ t: 'error', code: 'NOT_FOUND', message: 'gone', fatal: true }));
    expect(events.map((event) => event.t)).toEqual(['subscribed', 'snapshot', 'data', 'session', 'error']);

    connection.close();
    expect(sockets[0].closed).toBe(true);
    // A close the caller asked for is not reported back as a dropped socket.
    expect(events.filter((event) => event.t === 'closed')).toHaveLength(0);
  });

  test('reports a dropped socket and ignores frames after close', async () => {
    const events: PtyInspectorEvent[] = [];
    let socket: FakeSocket | null = null;
    connectPtyInspector('pty_abc123', (event) => events.push(event), {
      refreshAuth: async () => undefined,
      resolveUrl: (ptyId) => `ws://runtime.test/api/pty-inspector/ws?session=${ptyId}`,
      openSocket: (url) => { socket = createFakeSocket(url); return socket; },
    });
    await flush();
    if (!socket) throw new Error('socket not opened');
    // SAFETY: `socket` is only ever assigned the FakeSocket created by openSocket above.
    (socket as FakeSocket).onclose?.({ code: 1006, reason: '' });
    expect(events).toEqual([{ t: 'closed' }]);
  });

  test('does not open a socket when closed before the token is minted', async () => {
    let opened = 0;
    const connection = connectPtyInspector('pty_abc123', () => undefined, {
      refreshAuth: () => new Promise((resolve) => setTimeout(resolve, 5)),
      resolveUrl: (ptyId) => `ws://runtime.test/api/pty-inspector/ws?session=${ptyId}`,
      openSocket: (url) => { opened += 1; return createFakeSocket(url); },
    });
    connection.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opened).toBe(0);
  });
});
