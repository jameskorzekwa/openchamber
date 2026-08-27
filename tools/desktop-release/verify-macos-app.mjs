#!/usr/bin/env node

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = (message) => { throw new Error(message); };

const parseArgs = (tokens) => {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (!token?.startsWith('--') || value === undefined) fail(`Invalid argument near ${token || '<end>'}`);
    options[token.slice(2)] = value;
  }
  return options;
};

const required = (options, name) => options[name] || fail(`Missing --${name}`);

const run = (command, args, { allowFailure = false } = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`.trim());
  }
  return result;
};

const architecture = (path) => {
  const output = run('lipo', ['-archs', path]).stdout.trim().split(/\s+/).filter(Boolean);
  if (output.length !== 1 || output[0] !== 'arm64') fail(`${path} architectures are ${output.join(', ') || '(unknown)'}, expected arm64 only`);
};

const visit = (directory, predicate, matches = []) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path, predicate, matches);
    else if (entry.isFile() && predicate(path)) matches.push(path);
  }
  return matches;
};

const plistValue = (plist, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).stdout.trim();

const normalizeFingerprint = (value) => String(value || '').replaceAll(':', '').toUpperCase();

const verifySignedApp = ({ appPath, certificateSha256 }) => {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = run('codesign', ['-dvvv', appPath], { allowFailure: true }).stderr;
  if (!details.includes('flags=') || !details.includes('runtime')) fail('App signature does not enable hardened runtime');
  const directory = mkdtempSync(join(tmpdir(), 'openchamber-signature-'));
  try {
    const prefix = join(directory, 'certificate');
    run('codesign', ['--display', '--extract-certificates', prefix, appPath]);
    const fingerprint = run('openssl', [
      'x509', '-inform', 'DER', '-in', `${prefix}0`, '-noout', '-fingerprint', '-sha256',
    ]).stdout.trim().split('=').at(-1);
    if (normalizeFingerprint(fingerprint) !== normalizeFingerprint(certificateSha256)) {
      fail('App signing certificate SHA-256 fingerprint differs from the pinned identity');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const entitlements = run('codesign', ['-d', '--entitlements', ':-', appPath], { allowFailure: true }).stdout
    || run('codesign', ['-d', '--entitlements', ':-', appPath], { allowFailure: true }).stderr;
  if (entitlements.includes('com.apple.security.app-sandbox')) fail('App must not have the App Sandbox entitlement');
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) if (!entitlements.includes(`<key>${key}</key>`)) fail(`Required entitlement is missing: ${key}`);
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const appPath = resolve(required(options, 'app'));
  const dmgPath = resolve(required(options, 'dmg'));
  const version = required(options, 'version');
  const sourceCommit = required(options, 'source-commit');
  const opencodeVersion = required(options, 'opencode-version');
  const unsigned = options.unsigned === 'true';
  const contents = join(appPath, 'Contents');
  const resources = join(contents, 'Resources');
  const infoPlist = join(contents, 'Info.plist');
  const executableName = plistValue(infoPlist, 'CFBundleExecutable');
  if (plistValue(infoPlist, 'CFBundleShortVersionString') !== version) fail('App bundle version differs from the desktop release version');
  if (!plistValue(infoPlist, 'CFBundleVersion')) fail('App bundle build version is missing');
  architecture(join(contents, 'MacOS', executableName));

  const revision = JSON.parse(readFileSync(join(resources, 'web-dist', 'build-revision.json'), 'utf8')).revision;
  if (revision !== sourceCommit) fail(`Bundled UI revision ${revision} differs from ${sourceCommit}`);
  const uiIndex = join(resources, 'web-dist', 'index.html');
  if (!statSync(uiIndex).isFile()) fail('Bundled custom UI index is missing');
  if (visit(join(resources, 'web-dist'), (path) => /\/assets\/.*\.js$/.test(path)).length === 0) fail('Bundled custom UI JavaScript assets are missing');

  const cli = join(resources, 'opencode-cli', 'opencode');
  architecture(cli);
  const cliVersion = run(cli, ['--version']).stdout.trim().split(/\s+/)[0];
  if (cliVersion !== opencodeVersion) fail(`Bundled OpenCode CLI version ${cliVersion} differs from ${opencodeVersion}`);

  const nativeModules = visit(resources, (path) => path.endsWith('.node')
    && (!path.includes('/prebuilds/') || path.includes('/prebuilds/darwin-arm64/')));
  const bunPtyLibraries = visit(
    join(resources, 'app.asar.unpacked', 'node_modules', 'bun-pty'),
    (path) => path.endsWith('/librust_pty_arm64.dylib'),
  );
  if (!nativeModules.some((path) => path.includes('/node-pty/build/Release/pty.node'))
    || !nativeModules.some((path) => path.includes('/sherpa-onnx-darwin-arm64/'))
    || bunPtyLibraries.length === 0) {
    fail('Packaged app is missing rebuilt node-pty, bun-pty, or arm64 sherpa-onnx payloads');
  }
  for (const modulePath of [...nativeModules, ...bunPtyLibraries]) architecture(modulePath);

  if (!unsigned) verifySignedApp({
    appPath,
    certificateSha256: required(options, 'certificate-sha256'),
  });
  process.stdout.write(JSON.stringify({
    app: basename(appPath),
    version,
    sourceCommit,
    opencodeVersion,
    nativeModules: nativeModules.length + bunPtyLibraries.length,
    signed: !unsigned,
  }));
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
