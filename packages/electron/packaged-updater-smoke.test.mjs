import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPackagedUpdaterSmoke } from './packaged-updater-smoke.mjs';
import { runMacUpdaterSmokeHarness } from './scripts/run-packaged-macos-updater-smoke.mjs';
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

test('runner isolates the packaged process, records transfer evidence, and removes temporary state', {
  skip: process.platform === 'win32',
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-packaged-updater-runner-'));
  const appPath = path.join(root, 'Packaged.app');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'OpenChamber');
  const nextVersion = '1.21.0-j2k.27';
  const nextZip = path.join(root, `OpenChamber-${nextVersion}-mac-arm64.zip`);
  const outputPath = path.join(root, 'evidence.json');
  const isolationMarker = path.join(root, 'isolation-root.txt');
  const sourceRevision = 'a'.repeat(40);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(nextZip, 'signed fixture zip');
  fs.writeFileSync(executable, `#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.OPENCHAMBER_SMOKE_TEST_SECRET) process.exit(90);
const smokeRoot = process.env.OPENCHAMBER_UPDATER_SMOKE_ROOT;
if (!process.env.HOME.startsWith(smokeRoot) || !process.env.TMPDIR.startsWith(smokeRoot)) process.exit(91);
fs.writeFileSync(${JSON.stringify(isolationMarker)}, smokeRoot);
if (process.env.TZ === 'force-failure') {
  console.error(smokeRoot, import.meta.url);
  process.exit(92);
}
const feed = process.env.OPENCHAMBER_UPDATER_E2E_URL;
const manifest = await (await fetch(new URL('latest-mac.yml', feed))).text();
const payloadName = decodeURIComponent(manifest.match(/  - url: ([^\\n]+)/)[1]);
const payload = Buffer.from(await (await fetch(new URL(encodeURIComponent(payloadName), feed))).arrayBuffer());
const downloadedPath = path.join(smokeRoot, 'updater-cache', payloadName);
fs.mkdirSync(path.dirname(downloadedPath), { recursive: true });
fs.writeFileSync(downloadedPath, payload);
fs.writeFileSync(process.env.OPENCHAMBER_UPDATER_SMOKE_EVIDENCE, JSON.stringify({
  currentVersion: '1.21.0-j2k.26',
  discoveredVersion: process.env.OPENCHAMBER_UPDATER_SMOKE_NEXT_VERSION,
  feed,
  provider: 'generic',
  updaterCacheDirName: 'openchamber-updater',
  downloadedPayload: payloadName,
  downloadedBytes: payload.length,
  downloadedSha512: crypto.createHash('sha512').update(payload).digest('base64'),
  updaterErrors: 0,
  installationAttempted: false,
  completed: true,
}));
`);
  fs.chmodSync(executable, 0o755);

  try {
    const evidence = await runMacUpdaterSmokeHarness({
      appPath,
      nextZip,
      nextVersion,
      sourceRevision,
      outputPath,
      timeoutMs: 10_000,
      environment: {
        PATH: process.env.PATH,
        OPENCHAMBER_SMOKE_TEST_SECRET: 'must-not-reach-packaged-process',
      },
    });
    const isolationRoot = fs.readFileSync(isolationMarker, 'utf8');
    assert.equal(fs.existsSync(isolationRoot), false);
    assert.equal(evidence.currentVersion, '1.21.0-j2k.26');
    assert.equal(evidence.discoveredVersion, nextVersion);
    assert.equal(evidence.sourceRevision, sourceRevision);
    assert.equal(evidence.fixturePayload, path.basename(nextZip));
    assert.equal(evidence.payloadDownloaded, true);
    assert.equal(evidence.installationAttempted, false);

    await assert.rejects(
      runMacUpdaterSmokeHarness({
        appPath,
        nextZip,
        nextVersion,
        sourceRevision,
        outputPath,
        timeoutMs: 10_000,
        environment: { PATH: process.env.PATH, TZ: 'force-failure' },
      }),
      (error) => {
        const failedIsolationRoot = fs.readFileSync(isolationMarker, 'utf8');
        assert.equal(fs.existsSync(failedIsolationRoot), false);
        assert.equal(error.message.includes(failedIsolationRoot), false);
        assert.equal(error.message.includes(appPath), false);
        assert.match(error.message, /<isolated>/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
