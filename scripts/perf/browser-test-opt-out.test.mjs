// The Chrome-driven regressions in this directory find a system Chrome on their
// own, and GitHub's Linux and macOS runners ship one. J2K CI and release gates
// set OPENCHAMBER_SKIP_BROWSER_TESTS=1 to exclude them. Each file runs here in
// a subprocess against a fake Chrome that only records its launch: with the
// flag the file must skip without launching it; without the flag the launch
// must still happen.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const browserTests = readdirSync(directory).filter((name) => name.endsWith('.browser.test.mjs')).sort();

// Each run gets its own process group. The isolated test file, Vite and
// esbuild can outlive the `node --test` runner and keep the output pipes open,
// so `close` would never come. Every exit of the runner (normal, the spawn
// timeout, or an aborted test) ends the whole group, and the result settles on
// `close`, after the last member holding a pipe is gone.
const run = (args, env, { timeout = 150_000, signal, cwd, onOutput } = {}) => new Promise((resolve) => {
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
const liveMembers = (group) => spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout
  .split('\n').map((line) => line.trim().split(/\s+/))
  .filter(([pid, pgid, stat]) => pid && Number(pgid) === group && !stat.startsWith('Z'));

const withFakeChrome = async (argsFor, skipFlag, options = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fake-chrome-'));
  try {
    const launches = path.join(root, 'launches.log');
    const chrome = path.join(root, 'chrome');
    // Records the launch and exits without serving a debugging endpoint.
    writeFileSync(chrome, `#!/bin/sh\necho "$@" >> '${launches}'\nexit 1\n`);
    chmodSync(chrome, 0o700);
    const env = { ...process.env, ...options.env, OPENCHAMBER_TEST_CHROME: chrome };
    // Without this the child sees itself nested in this file's test run.
    delete env.NODE_TEST_CONTEXT;
    delete env.OPENCHAMBER_SKIP_BROWSER_TESTS;
    if (skipFlag) env.OPENCHAMBER_SKIP_BROWSER_TESTS = '1';
    const result = await run(argsFor(root), env, options);
    return { ...result, root, launches: existsSync(launches) ? readFileSync(launches, 'utf8') : '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const browserRun = (file) => () => ['--test', '--test-reporter=tap', path.join(directory, file)];

// Starts a descendant that holds the run's stderr pipe and never exits, then
// reports its PID. With FIXTURE_MODE=exit the script itself exits right away;
// otherwise it stays alive with the descendant.
const HUNG_DESCENDANT = `import { spawn, spawnSync } from 'node:child_process';
const descendant = spawn('/bin/sh', ['-c', 'echo $$; exec tail -f /dev/null'], { stdio: ['ignore', 'pipe', 'inherit'] });
descendant.stdout.once('data', (chunk) => {
  process.stdout.write('descendant ' + chunk);
  if (process.env.FIXTURE_MODE === 'exit') {
    descendant.stdout.destroy();
    descendant.unref();
  }
});
`;
const hungRun = (root) => {
  const fixture = path.join(root, 'hung-descendant.mjs');
  writeFileSync(fixture, HUNG_DESCENDANT);
  return [fixture];
};
const descendantOf = (output) => Number(output.match(/^descendant (\d+)$/m)?.[1]);

const skip = process.platform === 'win32' && 'The fake Chrome is a POSIX shell script';

test('the browser regressions are found', () => {
  assert.ok(browserTests.length >= 5, `found ${browserTests.join(', ')}`);
});

// Each unflagged file waits out the 15-second endpoint timeout; run them together.
describe('OPENCHAMBER_SKIP_BROWSER_TESTS', { concurrency: true }, () => {
  test('a descendant left behind by a runner that exits is ended with its group', { skip, timeout: 30_000 }, async () => {
    const result = await withFakeChrome(hungRun, false, { env: { FIXTURE_MODE: 'exit' } });
    assert.equal(result.error, undefined);
    assert.equal(result.code, 0, result.output);
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('a run that reaches its timeout ends the whole group', { skip, timeout: 30_000 }, async () => {
    const result = await withFakeChrome(hungRun, false, { timeout: 5_000 });
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('an aborted run ends the whole group', { skip, timeout: 30_000 }, async () => {
    const controller = new AbortController();
    const result = await withFakeChrome(hungRun, false, {
      signal: controller.signal,
      onOutput: (chunk) => { if (chunk.includes('descendant ')) controller.abort(); },
    });
    assert.equal(result.error?.name, 'AbortError');
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('a run that cannot start reports the spawn error and cleans up', { skip, timeout: 30_000 }, async () => {
    const result = await withFakeChrome(hungRun, false, { cwd: path.join(tmpdir(), 'missing-browser-opt-out-cwd') });
    assert.equal(result.error?.code, 'ENOENT');
    assert.equal(result.group, undefined);
    assert.equal(existsSync(result.root), false);
  });

for (const file of browserTests) {
  test(`${file} skips without launching Chrome when OPENCHAMBER_SKIP_BROWSER_TESTS=1`, { skip, timeout: 160_000 }, async () => {
    const { code, output, launches, error, group } = await withFakeChrome(browserRun(file), true);
    assert.equal(error, undefined);
    assert.deepEqual(liveMembers(group), []);
    assert.equal(launches, '', 'Chrome was not launched');
    assert.equal(code, 0, output);
    assert.match(output, /^ok 1 - .* # SKIP OPENCHAMBER_SKIP_BROWSER_TESTS=1/m);
    assert.match(output, /^# skipped 1$/m);
    assert.match(output, /^# fail 0$/m);
  });

  test(`${file} still launches Chrome when the flag is unset`, { skip, timeout: 160_000 }, async () => {
    const { code, output, launches, error, group } = await withFakeChrome(browserRun(file), false);
    assert.equal(error, undefined);
    assert.deepEqual(liveMembers(group), []);
    assert.match(launches, /--remote-debugging-port=\d+/, output);
    // The fake never serves a debugging endpoint, so the regression runs and fails.
    assert.notEqual(code, 0);
    assert.match(output, /^# skipped 0$/m);
  });
}
});
