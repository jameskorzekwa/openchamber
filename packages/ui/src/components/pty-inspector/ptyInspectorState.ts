import type { PtyInspectorEvent, PtySession } from '@/lib/ptyInspectorApi';

/**
 * Connection lifecycle as the pane sees it. `ended` is terminal: the process
 * finished or is gone, and the output stays on screen for reading.
 */
export type PtyInspectorState =
  | { kind: 'connecting' }
  | { kind: 'live'; session: PtySession | null }
  | { kind: 'ended'; session: PtySession | null }
  | { kind: 'unavailable'; reason: 'not-found' | 'unreachable' | 'misconfigured' | 'closed' };

export function reducePtyInspectorEvent(state: PtyInspectorState, event: PtyInspectorEvent): PtyInspectorState {
  switch (event.t) {
    case 'subscribed':
      return state.kind === 'connecting' ? { kind: 'live', session: null } : state;
    case 'snapshot':
    case 'data':
      return state.kind === 'connecting' ? { kind: 'live', session: null } : state;
    case 'session':
      if (event.session.status === 'running') return { kind: 'live', session: event.session };
      return { kind: 'ended', session: event.session };
    case 'error':
      if (!event.fatal) return state;
      if (event.code === 'NOT_FOUND' || event.code === 'BAD_SESSION') {
        // A process that already exited and was cleaned up still had output
        // worth keeping; only a never-seen session is "unavailable".
        return state.kind === 'live' || state.kind === 'ended'
          ? { kind: 'ended', session: state.session }
          : { kind: 'unavailable', reason: 'not-found' };
      }
      if (event.code === 'BAD_URL') return { kind: 'unavailable', reason: 'misconfigured' };
      return { kind: 'unavailable', reason: 'unreachable' };
    case 'closed':
      if (state.kind === 'ended' || state.kind === 'unavailable') return state;
      return { kind: 'unavailable', reason: 'closed' };
    default:
      return state;
  }
}
