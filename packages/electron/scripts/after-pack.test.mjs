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

const require = createRequire(import.meta.url);
const afterPack = require(afterPackPath);
const { writeAppUpdateConfig } = afterPack;
const { Arch } = require('electron-builder');
const { deriveExecutableUuid } = require('./macos-executable-uuid.cjs');

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

const packagedFixture = (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-after-pack-app-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const appInfo = { productFilename: 'OpenChamber', id: 'dev.openchamber.test' };
  const contents = path.join(appOutDir, `${appInfo.productFilename}.app`, 'Contents');
  const resourcesPath = path.join(contents, 'Resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  const web = 'node_modules/@openchamber/web';
  const packed = [
    'dist-bundle/entry.mjs', 'dist-bundle/main.mjs', 'dist-bundle/early-startup.mjs',
    'preload.mjs', 'browser-panel-preload.cjs', 'package.json',
    `${web}/package.json`, `${web}/build/server/index.js`, `${web}/build/server/index.js.map`,
    `${web}/build/bin/cli.js`,
  ];
  const unpacked = [
    ...['credential-helper', 'ssh-wrapper', 'repository-credential-helper']
      .flatMap((name) => [`${web}/build/server/lib/git/${name}.js`, `${web}/build/server/lib/git/${name}-runtime.js`]),
    `${web}/build/server/built-in-extensions/registry.json`,
  ];
  const header = { files: {} };
  for (const file of [...packed, ...unpacked]) {
    const segments = file.split('/');
    let directory = header;
    for (const segment of segments.slice(0, -1)) {
      directory.files[segment] ??= { files: {} };
      directory = directory.files[segment];
    }
    directory.files[segments.at(-1)] = { size: 0, offset: '0', unpacked: unpacked.includes(file) };
  }
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  fs.writeFileSync(path.join(resourcesPath, 'app.asar'), Buffer.concat([prefix, json]));
  for (const file of unpacked) {
    const destination = path.join(resourcesPath, 'app.asar.unpacked', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, '');
  }
  const ripgrep = path.join(resourcesPath, 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg');
  fs.mkdirSync(path.dirname(ripgrep), { recursive: true });
  fs.writeFileSync(ripgrep, '');
  const executablePath = path.join(contents, 'MacOS', appInfo.productFilename);
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  const executable = Buffer.alloc(56);
  executable.writeUInt32LE(0xfeedfacf, 0);
  executable.writeUInt32LE(1, 16);
  executable.writeUInt32LE(24, 20);
  executable.writeUInt32LE(0x1b, 32);
  executable.writeUInt32LE(24, 36);
  fs.writeFileSync(executablePath, executable);
  return {
    context: { appOutDir, packager: { appInfo }, electronPlatformName: 'darwin', arch: Arch.x64 },
    resourcesPath,
    executablePath,
    ripgrep,
  };
};

for (const j2kBuild of [false, true]) {
  test(`after-pack writes the ${j2kBuild ? 'J2K' : 'upstream'} feed into a validated macOS package`, (t) => {
    const previous = process.env.OPENCHAMBER_J2K_DESKTOP_BUILD;
    process.env.OPENCHAMBER_J2K_DESKTOP_BUILD = j2kBuild ? '1' : '0';
    t.after(() => {
      if (previous === undefined) delete process.env.OPENCHAMBER_J2K_DESKTOP_BUILD;
      else process.env.OPENCHAMBER_J2K_DESKTOP_BUILD = previous;
    });
    const { context, resourcesPath, executablePath } = packagedFixture(t);
    afterPack(context);
    assert.deepEqual(
      YAML.parse(fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8')),
      j2kBuild ? J2K_MACOS_APP_UPDATE_CONFIG : DEFAULT_APP_UPDATE_CONFIG,
    );
    assert.deepEqual(fs.readFileSync(executablePath).subarray(40, 56), deriveExecutableUuid(context.packager.appInfo.id));
    assert.ok(fs.statSync(path.join(resourcesPath, 'Assets.car')).size > 0);
  });
}

test('after-pack rejects incomplete contents before changing the executable or writing update configuration', (t) => {
  const { context, resourcesPath, executablePath, ripgrep } = packagedFixture(t);
  const originalExecutable = fs.readFileSync(executablePath);
  fs.rmSync(ripgrep);
  assert.throws(() => afterPack(context), /Packaged app contents check failed/);
  assert.deepEqual(fs.readFileSync(executablePath), originalExecutable);
  assert.equal(fs.existsSync(path.join(resourcesPath, 'app-update.yml')), false);
  assert.equal(fs.existsSync(path.join(resourcesPath, 'Assets.car')), false);
});
