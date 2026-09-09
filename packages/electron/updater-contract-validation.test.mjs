import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  J2K_MACOS_APP_UPDATE_CONFIG,
  parseAndValidateJ2kAppUpdateConfig,
  readAndValidateJ2kAppUpdateConfig,
} from './updater-contract-validation.mjs';

const validConfig = `provider: generic\nurl: ${J2K_MACOS_APP_UPDATE_CONFIG.url}\nupdaterCacheDirName: ${J2K_MACOS_APP_UPDATE_CONFIG.updaterCacheDirName}\n`;

test('accepts the complete J2K app-update.yml contract', () => {
  assert.deepEqual(parseAndValidateJ2kAppUpdateConfig(validConfig, { artifact: 'ZIP app' }), {
    ...J2K_MACOS_APP_UPDATE_CONFIG,
  });
});

test('rejects a final artifact whose Resources directory omits app-update.yml', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-final-app-resources-'));
  try {
    assert.throws(
      () => readAndValidateJ2kAppUpdateConfig(resources, { artifact: 'final DMG app' }),
      /final DMG app app-update.yml is missing from Contents\/Resources/,
    );
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});

for (const [name, content, expected] of [
  ['malformed YAML', 'provider: [generic\n', /ZIP app app-update.yml is malformed/],
  ['multiple YAML documents', `${validConfig}---\n${validConfig}`, /ZIP app app-update.yml is malformed/],
  ['duplicate fields', `${validConfig}provider: generic\n`, /Map keys must be unique/],
  ['unsupported provider', validConfig.replace('provider: generic', 'provider: github'), /provider differs/],
  ['wrong feed URL', validConfig.replace(J2K_MACOS_APP_UPDATE_CONFIG.url, 'https://example.invalid/'), /url differs/],
  ['wrong cache directory', validConfig.replace('openchamber-updater', 'other-updater'), /updaterCacheDirName differs/],
  ['missing field', validConfig.replace(/^url:.*\n/m, ''), /fields differ/],
  ['unexpected field', `${validConfig}channel: beta\n`, /fields differ/],
  ['non-mapping YAML', '- provider: generic\n', /must contain one YAML mapping/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => parseAndValidateJ2kAppUpdateConfig(content, { artifact: 'ZIP app' }),
      expected,
    );
  });
}
