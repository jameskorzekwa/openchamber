import { describe, expect, test } from 'bun:test';
import { reduceShellOutputEvent, toTerminalText, type ShellOutputState } from './shellOutputState';

describe('shell output pane state', () => {
  test('a first page or a running report makes a loading pane live', () => {
    expect(reduceShellOutputEvent({ kind: 'loading' }, { t: 'page' })).toEqual({ kind: 'running' });
    expect(reduceShellOutputEvent({ kind: 'loading' }, { t: 'running' })).toEqual({ kind: 'running' });
  });

  test('an end is terminal and keeps its status and exit code', () => {
    const ended = reduceShellOutputEvent({ kind: 'running' }, { t: 'ended', status: 'exited', exit: 2 });
    expect(ended).toEqual({ kind: 'ended', status: 'exited', exit: 2 });
    expect(reduceShellOutputEvent(ended, { t: 'running' })).toBe(ended);
    expect(reduceShellOutputEvent(ended, { t: 'page' })).toBe(ended);
  });

  test('a command OpenCode no longer knows is unavailable only when nothing was read', () => {
    expect(reduceShellOutputEvent({ kind: 'loading' }, { t: 'not-found' })).toEqual({ kind: 'unavailable' });
    expect(reduceShellOutputEvent({ kind: 'running' }, { t: 'not-found' })).toEqual({ kind: 'ended', status: 'unknown' });
    const stopped: ShellOutputState = { kind: 'ended', status: 'stopped' };
    expect(reduceShellOutputEvent(stopped, { t: 'not-found' })).toBe(stopped);
  });

  test('piped output gets terminal line ends without doubling existing ones', () => {
    expect(toTerminalText('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });
});
