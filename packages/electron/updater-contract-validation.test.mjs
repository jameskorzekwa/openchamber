import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  ['duplicate fields', `${validConfig}provider: generic\n`, /app-update.yml is malformed/],
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

const providerSentinel = randomUUID();
const urlSentinels = [randomUUID(), randomUUID(), randomUUID()];
const cacheSentinel = randomUUID();
for (const [field, rejectedValue, sentinels] of [
  ['provider', providerSentinel, [providerSentinel]],
  ['url', `https://${urlSentinels[0]}:${urlSentinels[1]}@example.invalid/feed?token=${urlSentinels[2]}`, urlSentinels],
  ['updaterCacheDirName', cacheSentinel, [cacheSentinel]],
]) {
  test(`does not expose a rejected ${field} value`, () => {
    const content = validConfig.replace(
      `${field}: ${J2K_MACOS_APP_UPDATE_CONFIG[field]}`,
      `${field}: ${rejectedValue}`,
    );
    assert.throws(
      () => parseAndValidateJ2kAppUpdateConfig(content, { artifact: 'final ZIP app' }),
      (error) => {
        assert.equal(
          error.message,
          `final ZIP app app-update.yml ${field} differs from the J2K package contract`,
        );
        for (const sentinel of sentinels) assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  });
}

test('does not expose malformed YAML source snippets', () => {
  const sourceSnippet = randomUUID();
  for (const malformed of [
    `provider: generic\nurl: "${sourceSnippet}\n`,
    `${validConfig}${sourceSnippet}: first\n${sourceSnippet}: second\n`,
  ]) {
    assert.throws(
      () => parseAndValidateJ2kAppUpdateConfig(malformed, { artifact: 'final DMG app' }),
      (error) => {
        assert.equal(error.message, 'final DMG app app-update.yml is malformed');
        assert.equal(error.message.includes(sourceSnippet), false);
        return true;
      },
    );
  }
});

test('does not expose unexpected field names', () => {
  const unexpectedField = `synthetic_${randomUUID().replaceAll('-', '_')}`;
  assert.throws(
    () => parseAndValidateJ2kAppUpdateConfig(`${validConfig}${unexpectedField}: true\n`, { artifact: 'final signed app' }),
    (error) => {
      assert.equal(
        error.message,
        'final signed app app-update.yml fields differ from the J2K package contract (unexpected field count: 1)',
      );
      assert.equal(error.message.includes(unexpectedField), false);
      return true;
    },
  );
});
