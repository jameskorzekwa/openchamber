// The Chrome-driven regressions in this directory find a system Chrome on their
// own, and GitHub's Linux and macOS runners ship one. J2K CI and release gates
// set OPENCHAMBER_SKIP_BROWSER_TESTS=1 to exclude them. Each file runs here in
// a subprocess against a fake Chrome that only records its launch: with the
// flag the file must skip without launching it; without the flag the launch
// must still happen.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const browserTests = readdirSync(directory).filter((name) => name.endsWith('.browser.test.mjs')).sort();

const runFile = (file, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', path.join(directory, file)], {
    env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 150_000, killSignal: 'SIGKILL',
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => resolve({ code, output }));
});

const withFakeChrome = async (file, skipFlag) => {
  const root = mkdtempSync(path.join(tmpdir(), 'fake-chrome-'));
  try {
    const launches = path.join(root, 'launches.log');
    const chrome = path.join(root, 'chrome');
    // Records the launch and exits without serving a debugging endpoint.
    writeFileSync(chrome, `#!/bin/sh\necho "$@" >> '${launches}'\nexit 1\n`);
    chmodSync(chrome, 0o700);
    const env = { ...process.env, OPENCHAMBER_TEST_CHROME: chrome };
    // Without this the child sees itself nested in this file's test run.
    delete env.NODE_TEST_CONTEXT;
    delete env.OPENCHAMBER_SKIP_BROWSER_TESTS;
    if (skipFlag) env.OPENCHAMBER_SKIP_BROWSER_TESTS = '1';
    const result = await runFile(file, env);
    return { ...result, launches: existsSync(launches) ? readFileSync(launches, 'utf8') : '' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const skip = process.platform === 'win32' && 'The fake Chrome is a POSIX shell script';

test('the browser regressions are found', () => {
  assert.ok(browserTests.length >= 5, `found ${browserTests.join(', ')}`);
});

// Each unflagged file waits out the 15-second endpoint timeout; run them together.
describe('OPENCHAMBER_SKIP_BROWSER_TESTS', { concurrency: true }, () => {
for (const file of browserTests) {
  test(`${file} skips without launching Chrome when OPENCHAMBER_SKIP_BROWSER_TESTS=1`, { skip, timeout: 160_000 }, async () => {
    const { code, output, launches } = await withFakeChrome(file, true);
    assert.equal(launches, '', 'Chrome was not launched');
    assert.equal(code, 0, output);
    assert.match(output, /^ok 1 - .* # SKIP OPENCHAMBER_SKIP_BROWSER_TESTS=1/m);
    assert.match(output, /^# skipped 1$/m);
    assert.match(output, /^# fail 0$/m);
  });

  test(`${file} still launches Chrome when the flag is unset`, { skip, timeout: 160_000 }, async () => {
    const { code, output, launches } = await withFakeChrome(file, false);
    assert.match(launches, /--remote-debugging-port=\d+/, output);
    // The fake never serves a debugging endpoint, so the regression runs and fails.
    assert.notEqual(code, 0);
    assert.match(output, /^# skipped 0$/m);
  });
}
});
