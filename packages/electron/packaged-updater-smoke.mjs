import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readAndValidateJ2kAppUpdateConfig } from './updater-contract-validation.mjs';
import { resolveUpdaterFeed, resolveUpdaterPrereleasePolicy } from './updater-feed.mjs';

const requiredEnvironment = (environment, name) => {
  const value = environment[name];
  if (!value) throw new Error(`Packaged updater smoke requires ${name}`);
  return value;
};

const hashFile = (filePath, algorithm, encoding) => {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(filePath));
  return hash.digest(encoding);
};

const withTimeout = async (promise, timeoutMs, phase) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Packaged updater smoke timed out during ${phase}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

export const shouldRunPackagedUpdaterSmoke = ({ app, environment, testBuild }) => (
  app.isPackaged
  && testBuild === true
  && environment.OPENCHAMBER_E2E === '1'
  && environment.OPENCHAMBER_PACKAGED_UPDATER_SMOKE === '1'
);

export const runPackagedUpdaterSmoke = async ({
  app,
  autoUpdater,
  environment = process.env,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  timeoutMs = 120_000,
}) => {
  if (platform !== 'darwin') throw new Error('Packaged updater smoke requires macOS');

  const isolationRoot = path.resolve(requiredEnvironment(environment, 'OPENCHAMBER_UPDATER_SMOKE_ROOT'));
  const evidencePath = path.resolve(requiredEnvironment(environment, 'OPENCHAMBER_UPDATER_SMOKE_EVIDENCE'));
  const expectedVersion = requiredEnvironment(environment, 'OPENCHAMBER_UPDATER_SMOKE_NEXT_VERSION');
  const expectedSha512 = requiredEnvironment(environment, 'OPENCHAMBER_UPDATER_SMOKE_NEXT_SHA512');

  const appUpdateConfig = readAndValidateJ2kAppUpdateConfig(resourcesPath, {
    artifact: 'packaged updater smoke app',
  });

  fs.mkdirSync(isolationRoot, { recursive: true });
  app.setPath('userData', path.join(isolationRoot, 'user-data'));
  app.setPath('cache', path.join(isolationRoot, 'cache'));

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = resolveUpdaterPrereleasePolicy({ platform, j2kBuild: true });
  autoUpdater.fullChangelog = true;
  autoUpdater.disableWebInstaller = false;

  const feed = resolveUpdaterFeed({ environment, j2kBuild: true, platform, testBuild: true });
  if (feed.provider !== 'generic' || !feed.url?.startsWith('http://127.0.0.1:')) {
    throw new Error('Packaged updater smoke requires its compile-time-gated loopback feed');
  }
  autoUpdater.setFeedURL(feed);

  const updaterErrors = [];
  const recordUpdaterError = (error) => updaterErrors.push(error);
  autoUpdater.on('error', recordUpdaterError);
  try {
    const checkResult = await withTimeout(autoUpdater.checkForUpdates(), timeoutMs, 'discovery');
    if (checkResult?.updateInfo?.version !== expectedVersion) {
      throw new Error(
        `Packaged updater smoke discovered ${checkResult?.updateInfo?.version || '(none)'}, expected ${expectedVersion}`,
      );
    }

    let downloadedEvent;
    let updaterError;
    const downloaded = new Promise((resolve, reject) => {
      downloadedEvent = (event) => resolve(event);
      updaterError = (error) => reject(error);
      autoUpdater.once('update-downloaded', downloadedEvent);
      autoUpdater.once('error', updaterError);
    });

    let downloadedPaths;
    try {
      [downloadedPaths] = await Promise.all([
        withTimeout(autoUpdater.downloadUpdate(), timeoutMs, 'download'),
        withTimeout(downloaded, timeoutMs, 'download completion event'),
      ]);
    } finally {
      if (downloadedEvent) autoUpdater.removeListener('update-downloaded', downloadedEvent);
      if (updaterError) autoUpdater.removeListener('error', updaterError);
    }

    const downloadedPath = downloadedPaths?.[0];
    if (!downloadedPath || !fs.statSync(downloadedPath).isFile()) {
      throw new Error('Packaged updater smoke did not return a downloaded payload');
    }
    const actualSha512 = hashFile(downloadedPath, 'sha512', 'base64');
    if (actualSha512 !== expectedSha512) {
      throw new Error('Packaged updater smoke downloaded payload SHA-512 differs from the trusted fixture');
    }

    const evidence = {
      currentVersion: app.getVersion(),
      discoveredVersion: checkResult.updateInfo.version,
      feed: feed.url,
      provider: appUpdateConfig.provider,
      updaterCacheDirName: appUpdateConfig.updaterCacheDirName,
      downloadedPayload: path.basename(downloadedPath),
      downloadedBytes: fs.statSync(downloadedPath).size,
      downloadedSha512: actualSha512,
      updaterErrors: updaterErrors.length,
      installationAttempted: false,
      completed: true,
    };
    if (updaterErrors.length > 0) throw updaterErrors[0];
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return evidence;
  } finally {
    autoUpdater.removeListener('error', recordUpdaterError);
  }
};
