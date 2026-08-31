import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRODUCTION_UPDATER_FEED,
  MACOS_PRODUCTION_UPDATER_FEED,
  parseLoopbackUpdaterUrl,
  resolveProductionUpdaterFeed,
  resolveUpdaterFeed,
  resolveUpdaterPrereleasePolicy,
} from './updater-feed.mjs';

const overrideEnvironment = {
  OPENCHAMBER_E2E: '1',
  OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:49152/updates/',
};

test('production updater feeds have explicit platform ownership', () => {
  assert.equal(Object.isFrozen(DEFAULT_PRODUCTION_UPDATER_FEED), true);
  assert.equal(Object.isFrozen(MACOS_PRODUCTION_UPDATER_FEED), true);
  assert.equal(resolveProductionUpdaterFeed({ platform: 'darwin' }), DEFAULT_PRODUCTION_UPDATER_FEED);
  assert.deepEqual(resolveProductionUpdaterFeed({ platform: 'darwin', j2kBuild: true }), {
    provider: 'generic',
    url: 'https://raw.githubusercontent.com/jameskorzekwa/openchamber/desktop-channel/',
  });
  assert.deepEqual(resolveProductionUpdaterFeed({ platform: 'win32' }), {
    provider: 'github',
    owner: 'openchamber',
    repo: 'openchamber',
  });
  assert.equal(resolveProductionUpdaterFeed({ platform: 'linux' }), DEFAULT_PRODUCTION_UPDATER_FEED);
  assert.equal(resolveUpdaterPrereleasePolicy({ platform: 'darwin' }), false);
  assert.equal(resolveUpdaterPrereleasePolicy({ platform: 'darwin', j2kBuild: true }), true);
  assert.equal(resolveUpdaterPrereleasePolicy({ platform: 'win32' }), false);
  assert.equal(resolveUpdaterPrereleasePolicy({ platform: 'linux' }), false);
});

test('requires the complete E2E environment and embedded build-marker conjunction', () => {
  const cases = [
    {},
    { environment: overrideEnvironment },
    { environment: { OPENCHAMBER_E2E: '1' }, testBuild: true },
    {
      environment: { OPENCHAMBER_UPDATER_E2E_URL: overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL },
      testBuild: true,
    },
    { environment: overrideEnvironment, testBuild: false },
  ];
  for (const input of cases) {
    assert.equal(resolveUpdaterFeed({ ...input, platform: 'win32' }), DEFAULT_PRODUCTION_UPDATER_FEED);
    assert.equal(resolveUpdaterFeed({ ...input, platform: 'darwin' }), DEFAULT_PRODUCTION_UPDATER_FEED);
    assert.equal(resolveUpdaterFeed({ ...input, platform: 'darwin', j2kBuild: true }), MACOS_PRODUCTION_UPDATER_FEED);
  }
});

test('accepts only credential-free loopback HTTP(S) URLs', () => {
  assert.equal(parseLoopbackUpdaterUrl('http://127.0.0.1:8080/feed'), 'http://127.0.0.1:8080/feed');
  assert.equal(parseLoopbackUpdaterUrl('https://127.255.0.1/feed/'), 'https://127.255.0.1/feed/');
  assert.equal(parseLoopbackUpdaterUrl('http://[::1]:8080/feed'), 'http://[::1]:8080/feed');

  for (const value of [
    'http://localhost:8080/feed',
    'http://0.0.0.0:8080/feed',
    'http://192.168.1.5:8080/feed',
    'https://example.com/feed',
    'file:///tmp/feed',
    'ftp://127.0.0.1/feed',
    'http://user:secret@127.0.0.1/feed',
    'http://127.0.0.1/feed?token=secret',
    'http://127.0.0.1/feed#fragment',
    'not-a-url',
  ]) assert.equal(parseLoopbackUpdaterUrl(value), null, value);
});

test('uses a generic feed only when every test-only gate is valid', () => {
  assert.deepEqual(resolveUpdaterFeed({
    environment: overrideEnvironment,
    j2kBuild: true,
    testBuild: true,
  }), {
    provider: 'generic',
    url: 'http://127.0.0.1:49152/updates/',
  });
});

test('invalid URLs fall back to the production feed even with both test gates', () => {
  for (const url of ['https://example.com/feed', 'http://localhost/feed', '']) {
    assert.equal(resolveUpdaterFeed({
      environment: { ...overrideEnvironment, OPENCHAMBER_UPDATER_E2E_URL: url },
      testBuild: true,
      j2kBuild: true,
      platform: 'darwin',
    }), MACOS_PRODUCTION_UPDATER_FEED);
  }
});
