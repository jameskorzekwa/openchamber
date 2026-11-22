/**
 * What the Process pane knows about one OpenCode background command. The
 * output keeps arriving in pages while the command runs; `ended` is terminal
 * and keeps the output on screen for reading.
 */
export type ShellOutputState =
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'ended'; status: 'exited' | 'timeout' | 'killed' | 'stopped' | 'unknown'; exit?: number }
  | { kind: 'unavailable' };

export type ShellOutputEvent =
  | { t: 'page' }
  | { t: 'running' }
  | { t: 'ended'; status: 'exited' | 'timeout' | 'killed' | 'stopped' | 'unknown'; exit?: number }
  | { t: 'not-found' };

export function reduceShellOutputEvent(state: ShellOutputState, event: ShellOutputEvent): ShellOutputState {
  switch (event.t) {
    case 'page':
      return state.kind === 'loading' || state.kind === 'unavailable' ? { kind: 'running' } : state;
    case 'running':
      return state.kind === 'ended' ? state : { kind: 'running' };
    case 'ended':
      return { kind: 'ended', status: event.status, ...(event.exit === undefined ? {} : { exit: event.exit }) };
    case 'not-found':
      // A command OpenCode already evicted keeps whatever output was read.
      return state.kind === 'loading' ? { kind: 'unavailable' } : state.kind === 'running' ? { kind: 'ended', status: 'unknown' } : state;
    default:
      return state;
  }
}

/** Shell output is piped text; the terminal emulator needs CRLF line ends. */
export const toTerminalText = (text: string): string => text.replace(/\r?\n/g, '\r\n');
