import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertChannelResponse, assertPackagedForkParity } from './smoke-installed-package.mjs';

const repository = 'jameskorzekwa/openchamber';
const currentVersion = '1.21.0-j2k.1';
const installation = (state, targetVersion = null) => ({
  schemaVersion: 1,
  state,
  currentVersion,
  targetVersion,
  previousVersion: null,
  error: null,
  updatedAt: '2026-08-26T00:00:00.000Z',
});

test('accepts only strict no-release, current, and available channel responses', () => {
  assert.doesNotThrow(() => assertChannelResponse({
    available: false,
    currentVersion,
    version: null,
    channel: 'j2k',
    channelRepository: repository,
    noValidatedRelease: true,
    installation: installation('no-validated-release'),
  }, { version: currentVersion, repository }));

  for (const available of [false, true]) {
    const version = available ? '1.22.0-j2k.1' : currentVersion;
    assert.doesNotThrow(() => assertChannelResponse({
      available,
      currentVersion,
      version,
      releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
      packageManager: 'validated-channel',
      updateCommand: 'openchamber update',
      channel: 'j2k',
      channelRepository: repository,
      installation: installation(available ? 'available' : 'installed', available ? version : null),
    }, { version: currentVersion, repository }));
  }
});

test('rejects a response from another channel or inconsistent state', () => {
  assert.throws(() => assertChannelResponse({
    available: false,
    currentVersion,
    version: null,
    channel: 'j2k',
    channelRepository: 'attacker/openchamber',
    noValidatedRelease: true,
    installation: installation('installed'),
  }, { version: currentVersion, repository }), /strict channel identity/);
});

test('smoke CLI rejects unknown options before execution', () => {
  const result = spawnSync(process.execPath, [resolve('tools/channel-release/smoke-installed-package.mjs'), '--unknown', 'value'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown smoke option/);
});

test('accepts only the exact companion web release URL when requested', () => {
  const body = {
    available: true,
    currentVersion,
    version: '1.22.0-j2k.1',
    releaseUrl: `https://github.com/${repository}/releases/tag/web-v1.22.0-j2k.1`,
    packageManager: 'validated-channel',
    updateCommand: 'openchamber update',
    channel: 'j2k',
    channelRepository: repository,
    installation: installation('available', '1.22.0-j2k.1'),
  };
  assert.doesNotThrow(() => assertChannelResponse(body, { version: currentVersion, repository, releaseTag: 'web-v1.22.0-j2k.1' }));
  assert.throws(() => assertChannelResponse(body, { version: currentVersion, repository }), /wrong release URL/);
});

test('checks packaged fork and plugin artifacts byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-parity-test-'));
  const source = join(root, 'source');
  const installed = join(root, 'installed');
  const paths = ['bin/cli.js', 'server/lib/agent-tool/runtime.js', 'server/lib/opm-status/routes.js', 'server/lib/session-goal/runtime.js'];
  try {
    for (const path of paths) {
      mkdirSync(join(source, path, '..'), { recursive: true });
      mkdirSync(join(installed, path, '..'), { recursive: true });
      writeFileSync(join(source, path), `${path}\n`);
      writeFileSync(join(installed, path), `${path}\n`);
    }
    assert.doesNotThrow(() => assertPackagedForkParity(installed, source));
    writeFileSync(join(installed, paths[1]), 'tampered\n');
    assert.throws(() => assertPackagedForkParity(installed, source), /differs from source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
