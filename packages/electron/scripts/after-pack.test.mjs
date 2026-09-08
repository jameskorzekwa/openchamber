import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import {
  DEFAULT_APP_UPDATE_CONFIG,
  J2K_MACOS_APP_UPDATE_CONFIG,
} from '../updater-feed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const afterPackPath = path.join(__dirname, 'after-pack.cjs');
const electronPackageDir = path.join(__dirname, '..');
const packageScriptPath = path.join(__dirname, 'package.mjs');

// Run the after-pack hook in a subprocess with controlled environment
const runAfterPack = ({ appOutDir, j2kBuild = false }) => {
  // Create a minimal context that the hook expects
  const script = `
    const afterPack = require(${JSON.stringify(afterPackPath)});
    const context = {
      electronPlatformName: 'darwin',
      appOutDir: ${JSON.stringify(appOutDir)},
      packager: {
        appInfo: {
          productFilename: 'OpenChamber',
        },
      },
    };
    afterPack(context);
    console.log('success');
  `;
  const result = spawnSync('node', ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCHAMBER_J2K_DESKTOP_BUILD: j2kBuild ? '1' : '',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`after-pack failed: ${result.stderr || result.stdout}`);
  }
  return result;
};

test('generates app-update.yml with J2K generic feed for OPENCHAMBER_J2K_DESKTOP_BUILD=1', (t) => {
  // Check if Assets.car exists (required by after-pack.cjs)
  const assetsSource = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');
  if (!fs.existsSync(assetsSource)) {
    t.skip('Skipping: Assets.car not found (requires macOS icon generation)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-after-pack-'));
  try {
    // Create minimal app structure - the hook expects appOutDir/OpenChamber.app/Contents/Resources
    const appOutDir = path.join(root, 'mac-arm64');
    const appDir = path.join(appOutDir, 'OpenChamber.app');
    const contentsDir = path.join(appDir, 'Contents');
    const resourcesDir = path.join(contentsDir, 'Resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    runAfterPack({ appOutDir, j2kBuild: true });

    // Verify app-update.yml was created
    const appUpdatePath = path.join(resourcesDir, 'app-update.yml');
    assert.ok(fs.existsSync(appUpdatePath), 'app-update.yml should exist');

    // Parse and validate the content
    const content = fs.readFileSync(appUpdatePath, 'utf8');
    const config = YAML.parse(content);

    assert.deepEqual(config, J2K_MACOS_APP_UPDATE_CONFIG);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generates app-update.yml with GitHub feed for non-J2K builds', (t) => {
  // Check if Assets.car exists (required by after-pack.cjs)
  const assetsSource = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');
  if (!fs.existsSync(assetsSource)) {
    t.skip('Skipping: Assets.car not found (requires macOS icon generation)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-after-pack-'));
  try {
    // Create minimal app structure - the hook expects appOutDir/OpenChamber.app/Contents/Resources
    const appOutDir = path.join(root, 'mac-arm64');
    const appDir = path.join(appOutDir, 'OpenChamber.app');
    const contentsDir = path.join(appDir, 'Contents');
    const resourcesDir = path.join(contentsDir, 'Resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    runAfterPack({ appOutDir, j2kBuild: false });

    // Verify app-update.yml was created
    const appUpdatePath = path.join(resourcesDir, 'app-update.yml');
    assert.ok(fs.existsSync(appUpdatePath), 'app-update.yml should exist');

    // Parse and validate the content
    const content = fs.readFileSync(appUpdatePath, 'utf8');
    const config = YAML.parse(content);

    assert.deepEqual(config, DEFAULT_APP_UPDATE_CONFIG);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package.mjs writes updater configuration to a no-publish unsigned macOS app', { timeout: 120_000 }, (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('macOS arm64 packaging requires a native macOS arm64 host');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-package-updater-'));
  try {
    const output = path.join(root, 'dist');
    const builderConfigPath = path.join(root, 'electron-builder.json');
    const builderConfig = {
      appId: 'dev.openchamber.desktop.characterization',
      productName: 'OpenChamber',
      files: ['preload.mjs'],
      extraMetadata: { main: 'preload.mjs' },
      afterPack: afterPackPath,
      directories: { output },
      mac: {
        identity: null,
        notarize: false,
        target: ['dir'],
      },
    };
    fs.writeFileSync(builderConfigPath, JSON.stringify(builderConfig));

    const result = spawnSync(process.execPath, [
      packageScriptPath,
      '--mac',
      '--arm64',
      '--dir',
      '--publish=never',
      '--config',
      builderConfigPath,
    ], {
      cwd: electronPackageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        OPENCHAMBER_J2K_DESKTOP_BUILD: '1',
        OPENCHAMBER_TARGET_ARCH: 'arm64',
      },
    });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const appUpdatePath = path.join(
      output,
      'mac-arm64',
      'OpenChamber.app',
      'Contents',
      'Resources',
      'app-update.yml',
    );
    const appUpdateConfig = YAML.parse(fs.readFileSync(appUpdatePath, 'utf8'));
    assert.deepEqual(appUpdateConfig, J2K_MACOS_APP_UPDATE_CONFIG);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
