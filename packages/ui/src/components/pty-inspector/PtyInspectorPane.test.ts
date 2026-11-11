import { describe, expect, test } from 'bun:test';

import { reducePtyInspectorEvent, type PtyInspectorState } from './ptyInspectorState';

const connecting: PtyInspectorState = { kind: 'connecting' };
const running = { id: 'pty_a', status: 'running' as const };
const exited = { id: 'pty_a', status: 'exited' as const, exitCode: 0 };

describe('reducePtyInspectorEvent', () => {
  test('goes live on the first frame and ends when the process exits', () => {
    const live = reducePtyInspectorEvent(connecting, { t: 'subscribed', sessionId: 'pty_a' });
    expect(live).toEqual({ kind: 'live', session: null });
    const withSession = reducePtyInspectorEvent(live, { t: 'session', session: running });
    expect(withSession).toEqual({ kind: 'live', session: running });
    const ended = reducePtyInspectorEvent(withSession, { t: 'session', session: exited });
    expect(ended).toEqual({ kind: 'ended', session: exited });
    // Output that arrives after the exit notice does not resurrect the process.
    expect(reducePtyInspectorEvent(ended, { t: 'data', sessionId: 'pty_a', data: 'x' })).toBe(ended);
    expect(reducePtyInspectorEvent(ended, { t: 'closed' })).toBe(ended);
  });

  test('a session that was never seen is unavailable; one that was seen keeps its output', () => {
    const notFound = { t: 'error' as const, code: 'NOT_FOUND', message: 'gone', fatal: true };
    expect(reducePtyInspectorEvent(connecting, notFound)).toEqual({ kind: 'unavailable', reason: 'not-found' });
    const live = reducePtyInspectorEvent(connecting, { t: 'snapshot', sessionId: 'pty_a', data: 'hi' });
    expect(reducePtyInspectorEvent(live, notFound)).toEqual({ kind: 'ended', session: null });
  });

  test('maps transport failures and ignores non-fatal errors', () => {
    expect(reducePtyInspectorEvent(connecting, { t: 'error', code: 'BAD_URL', message: 'm', fatal: true })).toEqual({ kind: 'unavailable', reason: 'misconfigured' });
    expect(reducePtyInspectorEvent(connecting, { t: 'error', code: 'UNREACHABLE', message: 'm', fatal: true })).toEqual({ kind: 'unavailable', reason: 'unreachable' });
    expect(reducePtyInspectorEvent(connecting, { t: 'error', code: 'UPSTREAM', message: 'm', fatal: false })).toBe(connecting);
    expect(reducePtyInspectorEvent({ kind: 'live', session: running }, { t: 'closed' })).toEqual({ kind: 'unavailable', reason: 'closed' });
  });
});
