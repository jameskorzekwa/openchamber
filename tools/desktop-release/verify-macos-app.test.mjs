import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { J2K_MACOS_APP_UPDATE_CONFIG } from '../../packages/electron/updater-contract-validation.mjs';
import { verifyMacosApp } from './verify-macos-app.mjs';

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const version = '1.21.0-j2k.25';
const validAppUpdateConfig = [
  `provider: ${J2K_MACOS_APP_UPDATE_CONFIG.provider}`,
  `url: ${J2K_MACOS_APP_UPDATE_CONFIG.url}`,
  `updaterCacheDirName: ${J2K_MACOS_APP_UPDATE_CONFIG.updaterCacheDirName}`,
  '',
].join('\n');

const writeFixtureApp = (root, appUpdateConfig = validAppUpdateConfig) => {
  const app = join(root, 'OpenChamber.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  const directories = [
    join(contents, 'MacOS'),
    join(resources, 'web-dist', 'assets'),
    join(resources, 'opencode-cli'),
    join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release'),
    join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-darwin-arm64'),
    join(resources, 'app.asar.unpacked', 'node_modules', 'bun-pty'),
  ];
  for (const directory of directories) mkdirSync(directory, { recursive: true });

  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OpenChamber</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>25</string>
</dict></plist>
`);
  writeFileSync(join(contents, 'MacOS', 'OpenChamber'), 'fixture');
  writeFileSync(join(resources, 'web-dist', 'build-revision.json'), `${JSON.stringify({ revision: sourceCommit })}\n`);
  writeFileSync(join(resources, 'web-dist', 'index.html'), '<!doctype html>');
  writeFileSync(join(resources, 'web-dist', 'assets', 'index.js'), '');
  writeFileSync(join(resources, 'opencode-cli', 'opencode'), 'fixture');
  writeFileSync(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'fixture');
  writeFileSync(join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-darwin-arm64', 'sherpa.node'), 'fixture');
  writeFileSync(join(resources, 'app.asar.unpacked', 'node_modules', 'bun-pty', 'librust_pty_arm64.dylib'), 'fixture');
  if (appUpdateConfig !== null) writeFileSync(join(resources, 'app-update.yml'), appUpdateConfig);
  return app;
};

const createFixtureRoot = (context) => {
  const root = mkdtempSync(join(tmpdir(), 'openchamber-macos-verifier-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

const verifyFixtureApp = ({ app, artifact }) => verifyMacosApp({
  app,
  dmg: join(app, '..', 'not-created.dmg'),
  version,
  'source-commit': sourceCommit,
  'opencode-version': '1.18.23',
  unsigned: 'true',
  'skip-cli-execution': 'true',
  'artifact-label': artifact,
}, {
  verifyArchitecture: () => {},
  readPlistValue: (_plist, key) => ({
    CFBundleExecutable: 'OpenChamber',
    CFBundleShortVersionString: version,
    CFBundleVersion: '25',
  })[key],
});

test('accepts updater configuration from the final application bundle', (context) => {
  const root = createFixtureRoot(context);
  const app = writeFixtureApp(join(root, 'signed'));
  const result = verifyFixtureApp({ app, artifact: 'final signed app fixture' });

  assert.deepEqual(result, {
    app: 'OpenChamber.app',
    version,
    sourceCommit,
    opencodeVersion: '1.18.23',
    nativeModules: 3,
    signed: false,
    artifact: 'final signed app fixture',
    updaterFeed: 'generic',
  });
});

for (const [name, config, field] of [
  ['missing configuration', null, 'missing from Contents/Resources'],
  ['malformed YAML', 'provider: [generic\n', 'malformed'],
  ['multiple YAML documents', `${validAppUpdateConfig}---\n${validAppUpdateConfig}`, 'malformed'],
  ['duplicate fields', `${validAppUpdateConfig}provider: generic\n`, 'Map keys must be unique'],
  ['non-mapping YAML', '- provider: generic\n', 'one YAML mapping'],
  ['unsupported provider', validAppUpdateConfig.replace('provider: generic', 'provider: github'), 'provider differs'],
  ['wrong feed URL', validAppUpdateConfig.replace(J2K_MACOS_APP_UPDATE_CONFIG.url, 'https://example.invalid/'), 'url differs'],
  ['wrong updater cache directory', validAppUpdateConfig.replace('openchamber-updater', 'other-updater'), 'updaterCacheDirName differs'],
  ['missing feed setting', validAppUpdateConfig.replace(/^url:.*\n/m, ''), 'fields differ'],
  ['unexpected channel setting', `${validAppUpdateConfig}channel: beta\n`, 'fields differ'],
]) {
  test(`rejects final artifact with ${name}`, (context) => {
    const root = createFixtureRoot(context);
    const artifact = `final ZIP app fixture: ${name}`;
    const app = writeFixtureApp(join(root, name.replaceAll(' ', '-')), config);
    assert.throws(() => verifyFixtureApp({ app, artifact }), (error) => {
      assert.match(error.message, new RegExp(artifact));
      assert.match(error.message, new RegExp(field));
      return true;
    });
  });
}

test('valid source and intermediate configuration cannot replace missing or invalid final configuration', (context) => {
  const root = createFixtureRoot(context);
  writeFileSync(join(root, 'source-app-update.yml'), validAppUpdateConfig);
  const intermediateApp = writeFixtureApp(join(root, 'intermediate'));

  for (const [name, config, field] of [
    ['missing', null, 'missing from Contents/Resources'],
    ['invalid', validAppUpdateConfig.replace('provider: generic', 'provider: github'), 'provider differs'],
  ]) {
    const finalApp = join(root, `final-${name}`, 'OpenChamber.app');
    cpSync(intermediateApp, finalApp, { recursive: true });
    const finalConfig = join(finalApp, 'Contents', 'Resources', 'app-update.yml');
    if (config === null) rmSync(finalConfig);
    else writeFileSync(finalConfig, config);

    assert.throws(
      () => verifyFixtureApp({ app: finalApp, artifact: `final DMG app fixture: ${name}` }),
      new RegExp(field),
    );
  }
});
