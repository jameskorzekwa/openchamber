// Runs a Node subprocess in its own process group and settles only after
// every group member holding its output pipes is gone. Used by the test
// harnesses in this directory.
import { spawn, spawnSync } from 'node:child_process';

// Each run gets its own process group. The isolated test file, Vite and
// esbuild can outlive the `node --test` runner and keep the output pipes open,
// so `close` would never come. Every exit of the runner (normal, the spawn
// timeout, or an aborted test) ends the whole group, and the result settles on
// `close`, after the last member holding a pipe is gone.
export const runInGroup = (args, env, { timeout = 150_000, signal, cwd, onOutput } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, {
    env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', signal,
  });
  let output = '';
  let error;
  const append = (chunk) => {
    output += chunk;
    onOutput?.(String(chunk));
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('exit', () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (cause) {
      if (cause.code !== 'ESRCH') error ??= cause;
    }
  });
  child.on('error', (cause) => {
    error ??= cause;
    // A child that never started has no group and may never close.
    if (child.pid === undefined) resolve({ code: null, output, error });
  });
  child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal, output, error, group: child.pid }));
});

// Members of a process group that are still running; exited (zombie) ones
// hold no pipe and are left to their reaper.
export const liveMembers = (group) => spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout
  .split('\n').map((line) => line.trim().split(/\s+/))
  .filter(([pid, pgid, stat]) => pid && Number(pgid) === group && !stat.startsWith('Z'));
