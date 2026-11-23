// The Chrome-driven regressions in this directory find a system Chrome on their
// own, and GitHub's Linux and macOS runners ship one. J2K CI and release gates
// set OPENCHAMBER_SKIP_BROWSER_TESTS=1 to exclude them. Each file runs here in
// a subprocess against a fake Chrome that only records its launch: with the
// flag the file must skip without launching it; without the flag the launch
// must still happen.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { liveMembers, runInGroup } from './process-group.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const browserTests = readdirSync(directory).filter((name) => name.endsWith('.browser.test.mjs')).sort();

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
    const result = await runInGroup(argsFor(root), env, options);
    return {
      ...result, root, collected: options.collect?.(root),
      launches: existsSync(launches) ? readFileSync(launches, 'utf8') : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const browserRun = (file) => () => ['--test', '--test-reporter=tap', path.join(directory, file)];

// Starts a descendant that holds the run's stderr pipe and never exits, then
// reports its PID. With FIXTURE_MODE=exit the script itself exits right away;
// otherwise it stays alive with the descendant.
const HUNG_DESCENDANT = `import { spawn } from 'node:child_process';
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
// A test file whose test node:test cancels (through its `signal` option) once
// the hung descendant reports in. Only the cancelled test's own `t.signal`
// reaches the helper; the outcome is recorded next to the file.
const CANCELLED_TEST = `import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { liveMembers, runInGroup } from ${JSON.stringify(pathToFileURL(path.join(directory, 'process-group.mjs')).href)};
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const cancel = new AbortController();
test('cancelled while its subprocess hangs', { signal: cancel.signal }, async (t) => {
  const result = await runInGroup([here('hung-descendant.mjs')], process.env, {
    signal: t.signal,
    onOutput: (chunk) => { if (chunk.includes('descendant ')) cancel.abort(); },
  });
  writeFileSync(here('outcome.json'), JSON.stringify({ error: result.error?.name, output: result.output, live: liveMembers(result.group).length }));
});
`;
const cancelledRun = (root) => {
  hungRun(root);
  const file = path.join(root, 'cancelled.test.mjs');
  writeFileSync(file, CANCELLED_TEST);
  return ['--test', '--test-reporter=tap', file];
};
const outcomeOf = (root) => {
  const file = path.join(root, 'outcome.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

const descendantOf = (output) => Number(output.match(/^descendant (\d+)$/m)?.[1]);

const skip = process.platform === 'win32' && 'The fake Chrome is a POSIX shell script';

test('the browser regressions are found', () => {
  assert.ok(browserTests.length >= 5, `found ${browserTests.join(', ')}`);
});

// Each unflagged file waits out the 15-second endpoint timeout; run them together.
describe('OPENCHAMBER_SKIP_BROWSER_TESTS', { concurrency: true }, () => {
  test('a descendant left behind by a runner that exits is ended with its group', { skip, timeout: 30_000 }, async (t) => {
    const result = await withFakeChrome(hungRun, false, { env: { FIXTURE_MODE: 'exit' }, signal: t.signal });
    assert.equal(result.error, undefined);
    assert.equal(result.code, 0, result.output);
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('a run that reaches its timeout ends the whole group', { skip, timeout: 30_000 }, async (t) => {
    const result = await withFakeChrome(hungRun, false, { timeout: 5_000, signal: t.signal });
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('an aborted run ends the whole group', { skip, timeout: 30_000 }, async (t) => {
    const controller = new AbortController();
    const result = await withFakeChrome(hungRun, false, {
      signal: AbortSignal.any([t.signal, controller.signal]),
      onOutput: (chunk) => { if (chunk.includes('descendant ')) controller.abort(); },
    });
    assert.equal(result.error?.name, 'AbortError');
    assert.ok(descendantOf(result.output) > 0, result.output);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('cancelling a test aborts its t.signal and ends the group it handed to the helper', { skip, timeout: 30_000 }, async (t) => {
    const result = await withFakeChrome(cancelledRun, false, { signal: t.signal, collect: outcomeOf });
    assert.equal(result.error, undefined);
    assert.match(result.output, /^not ok 1 - cancelled while its subprocess hangs$/m, result.output);
    assert.notEqual(result.code, 0);
    assert.ok(result.collected, result.output);
    assert.equal(result.collected.error, 'AbortError');
    assert.ok(descendantOf(result.collected.output) > 0, result.collected.output);
    assert.equal(result.collected.live, 0);
    assert.deepEqual(liveMembers(result.group), []);
    assert.equal(existsSync(result.root), false);
  });

  test('a run that cannot start reports the spawn error and cleans up', { skip, timeout: 30_000 }, async (t) => {
    const result = await withFakeChrome(hungRun, false, { cwd: path.join(tmpdir(), 'missing-browser-opt-out-cwd'), signal: t.signal });
    assert.equal(result.error?.code, 'ENOENT');
    assert.equal(result.group, undefined);
    assert.equal(existsSync(result.root), false);
  });

for (const file of browserTests) {
  test(`${file} skips without launching Chrome when OPENCHAMBER_SKIP_BROWSER_TESTS=1`, { skip, timeout: 160_000 }, async (t) => {
    const { code, output, launches, error, group } = await withFakeChrome(browserRun(file), true, { signal: t.signal });
    assert.equal(error, undefined);
    assert.deepEqual(liveMembers(group), []);
    assert.equal(launches, '', 'Chrome was not launched');
    assert.equal(code, 0, output);
    assert.match(output, /^ok 1 - .* # SKIP OPENCHAMBER_SKIP_BROWSER_TESTS=1/m);
    assert.match(output, /^# skipped 1$/m);
    assert.match(output, /^# fail 0$/m);
  });

  test(`${file} still launches Chrome when the flag is unset`, { skip, timeout: 160_000 }, async (t) => {
    const { code, output, launches, error, group } = await withFakeChrome(browserRun(file), false, { signal: t.signal });
    assert.equal(error, undefined);
    assert.deepEqual(liveMembers(group), []);
    assert.match(launches, /--remote-debugging-port=\d+/, output);
    // The fake never serves a debugging endpoint, so the regression runs and fails.
    assert.notEqual(code, 0);
    assert.match(output, /^# skipped 0$/m);
  });
}
});
