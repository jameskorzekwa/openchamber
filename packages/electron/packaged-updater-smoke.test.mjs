import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPackagedUpdaterSmoke } from './packaged-updater-smoke.mjs';
import { J2K_MACOS_APP_UPDATE_CONFIG } from './updater-contract-validation.mjs';

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-packaged-updater-smoke-'));
  const resources = path.join(root, 'resources');
  const downloadedPath = path.join(root, 'OpenChamber-next.zip');
  const evidencePath = path.join(root, 'evidence.json');
  fs.mkdirSync(resources);
  fs.writeFileSync(
    path.join(resources, 'app-update.yml'),
    `provider: generic\nurl: ${J2K_MACOS_APP_UPDATE_CONFIG.url}\nupdaterCacheDirName: ${J2K_MACOS_APP_UPDATE_CONFIG.updaterCacheDirName}\n`,
  );
  fs.writeFileSync(downloadedPath, 'signed fixture payload');
  const environment = {
    OPENCHAMBER_E2E: '1',
    OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:49152/',
    OPENCHAMBER_UPDATER_SMOKE_ROOT: path.join(root, 'isolated'),
    OPENCHAMBER_UPDATER_SMOKE_EVIDENCE: evidencePath,
    OPENCHAMBER_UPDATER_SMOKE_NEXT_VERSION: '1.21.0-j2k.27',
    OPENCHAMBER_UPDATER_SMOKE_NEXT_SHA512: crypto.createHash('sha512').update('signed fixture payload').digest('base64'),
  };
  const app = {
    getVersion: () => '1.21.0-j2k.26',
    setPath: () => {},
  };
  return { app, downloadedPath, environment, evidencePath, resources, root };
};

test('uses electron-updater for discovery and completed payload download', async () => {
  const fixture = createFixture();
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = (feed) => { autoUpdater.feed = feed; };
  autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '1.21.0-j2k.27' } });
  autoUpdater.downloadUpdate = async () => {
    queueMicrotask(() => autoUpdater.emit('update-downloaded', { version: '1.21.0-j2k.27' }));
    return [fixture.downloadedPath];
  };
  try {
    const evidence = await runPackagedUpdaterSmoke({
      app: fixture.app,
      autoUpdater,
      environment: fixture.environment,
      platform: 'darwin',
      resourcesPath: fixture.resources,
      timeoutMs: 1_000,
    });
    assert.equal(autoUpdater.feed.url, fixture.environment.OPENCHAMBER_UPDATER_E2E_URL);
    assert.equal(evidence.completed, true);
    assert.equal(JSON.parse(fs.readFileSync(fixture.evidencePath, 'utf8')).downloadedPayload, 'OpenChamber-next.zip');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails before discovery when packaged app-update.yml is missing', async () => {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.resources, 'app-update.yml'));
  try {
    await assert.rejects(
      runPackagedUpdaterSmoke({
        app: fixture.app,
        autoUpdater: new EventEmitter(),
        environment: fixture.environment,
        platform: 'darwin',
        resourcesPath: fixture.resources,
      }),
      /app-update.yml is missing from Contents\/Resources/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails when discovery succeeds but electron-updater download fails', async () => {
  const fixture = createFixture();
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '1.21.0-j2k.27' } });
  autoUpdater.downloadUpdate = async () => { throw new Error('fixture payload unavailable'); };
  try {
    await assert.rejects(
      runPackagedUpdaterSmoke({
        app: fixture.app,
        autoUpdater,
        environment: fixture.environment,
        platform: 'darwin',
        resourcesPath: fixture.resources,
        timeoutMs: 1_000,
      }),
      /fixture payload unavailable/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
