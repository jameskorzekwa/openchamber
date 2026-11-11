import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import {
  DEFAULT_APP_UPDATE_CONFIG,
  J2K_MACOS_APP_UPDATE_CONFIG,
} from '../updater-feed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const afterPackPath = path.join(__dirname, 'after-pack.cjs');

const { writeAppUpdateConfig } = createRequire(import.meta.url)(afterPackPath);

const writeConfig = ({ platform, j2kBuild }) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-after-pack-'));
  try {
    writeAppUpdateConfig({ resourcesPath, platform, j2kBuild });
    return YAML.parse(fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8'));
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
};

test('writes app-update.yml with the J2K generic feed for a J2K macOS build', () => {
  assert.deepEqual(writeConfig({ platform: 'darwin', j2kBuild: true }), J2K_MACOS_APP_UPDATE_CONFIG);
});

test('writes app-update.yml with the GitHub feed for other builds', () => {
  assert.deepEqual(writeConfig({ platform: 'darwin', j2kBuild: false }), DEFAULT_APP_UPDATE_CONFIG);
  assert.deepEqual(writeConfig({ platform: 'linux', j2kBuild: true }), DEFAULT_APP_UPDATE_CONFIG);
});

test('the after-pack hook writes app-update.yml after the macOS app checks', () => {
  const source = fs.readFileSync(afterPackPath, 'utf8');
  const hook = source.slice(source.indexOf('const afterPack = (context) => {'));
  const write = hook.indexOf('writeAppUpdateConfig({');
  assert.ok(hook.indexOf('verifyPackagedAppContents(') >= 0 && hook.indexOf('verifyPackagedAppContents(') < write);
  assert.ok(hook.indexOf("process.env.OPENCHAMBER_J2K_DESKTOP_BUILD === '1'") > write);
});

// The packaged app itself is checked by tools/desktop-release/verify-macos-app.mjs
// in the J2K release workflow: upstream's packaged-content verification rejects
// the minimal app a local characterization build would produce.
