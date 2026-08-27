import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertChannelResponse } from './smoke-installed-package.mjs';

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
