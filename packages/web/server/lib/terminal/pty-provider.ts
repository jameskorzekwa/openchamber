import { bunVersionRunsBunPty } from './bun-pty-support.js';
import type { IWindowsPtyForkOptions, IPtyForkOptions } from 'node-pty';

export type TerminalBackend = 'bun-pty' | 'node-pty';
export type PtyOptions = IPtyForkOptions & IWindowsPtyForkOptions;
export type PtyExit = { exitCode: number; signal?: number | string | undefined };
export type Disposable = { dispose(): void };

export interface TerminalPty {
  pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExit) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalPtyModule {
  spawn(executable: string, args: string[], options: PtyOptions): TerminalPty | Promise<TerminalPty>;
}

export interface TerminalPtyProvider extends TerminalPtyModule {
  backend: TerminalBackend;
}

export async function loadTerminalPtyProvider(
  bunVersion: string | null | undefined = globalThis.Bun?.version,
  importPty: (name: TerminalBackend) => Promise<TerminalPtyModule> = (name) => name === 'bun-pty' ? import('bun-pty') : import('node-pty'),
): Promise<TerminalPtyProvider> {
  if (bunVersionRunsBunPty(bunVersion)) {
    try { const pty = await importPty('bun-pty'); return { spawn: pty.spawn, backend: 'bun-pty' }; } catch { void 0; }
  }
  const pty = await importPty('node-pty');
  return { spawn: pty.spawn, backend: 'node-pty' };
}
