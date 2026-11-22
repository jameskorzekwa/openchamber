import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdaterChannelApplier } from './updater-channel-application.mjs';

const fixture = (options = {}) => {
  const feeds = [];
  const logs = [];
  const autoUpdater = { setFeedURL: (feed) => feeds.push(feed), allowDowngrade: false };
  const state = { updaterChannel: null, updaterSource: null, updaterMirrorFailedAt: null, pendingUpdate: null };
  const apply = createUpdaterChannelApplier({
    autoUpdater,
    state,
    appVersion: '2.8.0',
    platform: 'linux',
    architecture: 'x64',
    testBuild: false,
    j2kBuild: false,
    log: { info: (...args) => logs.push(args) },
    ...options,
  });
  return { apply, feeds, logs, autoUpdater, state };
};

test('repeated channel application preserves downloads; source fallback keeps the same pending update', () => {
  const { apply, state, feeds, logs } = fixture();
  apply('stable');
  state.pendingUpdate = { version: '2.8.1', downloaded: true };
  const pending = state.pendingUpdate;
  apply('stable');
  assert.equal(feeds.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(feeds[0].url, 'https://downloads.openchamber.dev/desktop/stable/');
  assert.equal(state.pendingUpdate, pending);
  state.updaterMirrorFailedAt = Date.now();
  apply('stable');
  assert.deepEqual(feeds[1], { provider: 'github', owner: 'openchamber', repo: 'openchamber' });
  assert.equal(state.pendingUpdate, pending);
  assert.equal(state.updaterSource, 'github');
  apply('canary', 'mirror');
  assert.equal(state.pendingUpdate, null);
  assert.equal(feeds[2].url, 'https://downloads.openchamber.dev/desktop/canary/');
  assert.equal(state.updaterChannel, 'canary');
});

test('Windows ARM64 uses its own manifest and logs the applied configuration', () => {
  const { apply, autoUpdater, logs } = fixture({ platform: 'win32', architecture: 'arm64' });
  apply('stable', 'github');
  assert.equal(autoUpdater.channel, 'latest-arm64');
  assert.deepEqual(logs[0], ['[electron] updater feed configured', {
    channel: 'stable',
    source: 'github',
    provider: 'github',
    target: 'openchamber/openchamber',
    manifest: 'latest-arm64',
    allowDowngrade: false,
  }]);
});

test('J2K macOS keeps its fork feed for both channels and does not override its manifest', () => {
  const { apply, autoUpdater, feeds, logs } = fixture({ platform: 'darwin', architecture: 'arm64', j2kBuild: true });
  apply('stable', 'mirror');
  apply('canary', 'github');
  assert.deepEqual(feeds[0], feeds[1]);
  assert.equal(feeds[0].provider, 'generic');
  assert.match(feeds[0].url, /jameskorzekwa\/openchamber/);
  assert.equal(autoUpdater.channel, undefined);
  assert.equal(logs[0][1].manifest, 'latest');
});

test('only an explicit Stable choice from a Canary build permits downgrades', () => {
  const canary = fixture({ appVersion: '2.8.0-canary.1' });
  canary.apply('canary');
  assert.equal(canary.autoUpdater.allowDowngrade, false);
  canary.apply('stable');
  assert.equal(canary.autoUpdater.allowDowngrade, true);
  canary.apply('canary');
  assert.equal(canary.autoUpdater.allowDowngrade, false);
  const stable = fixture();
  stable.apply('stable');
  assert.equal(stable.autoUpdater.allowDowngrade, false);
});

test('failed feed configuration does not commit channel identity and can be retried', () => {
  const { apply, autoUpdater, state, feeds, logs } = fixture();
  apply('stable');
  const setFeedURL = autoUpdater.setFeedURL;
  autoUpdater.setFeedURL = () => { throw new Error('feed rejected'); };
  assert.throws(() => apply('canary'), /feed rejected/);
  assert.equal(state.updaterChannel, 'stable');
  assert.equal(logs.length, 1);
  autoUpdater.setFeedURL = setFeedURL;
  apply('canary');
  assert.equal(feeds.length, 2);
  assert.equal(state.updaterChannel, 'canary');
});
