#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateArtifactTarget, verifyRelocatableArchive } from './artifact.mjs';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const allowed = new Set(['arch', 'channel-repository', 'node-abi', 'platform', 'source-commit', 'tarball', 'version']);
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    const name = key.slice(2);
    if (!allowed.has(name)) fail(`Unknown smoke option: --${name}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate smoke option: --${name}`);
    options[name] = value;
  }
  return options;
}

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return server.address().port;
}

async function waitFor(url, child, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`Installed OpenChamber exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The process may still be binding its port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail(`Timed out waiting for ${url}`);
}

export function assertChannelResponse(body, { version, repository }) {
  const commonKeys = ['available', 'channel', 'channelRepository', 'currentVersion', 'installation', 'version'];
  if (body.channel !== 'j2k' || body.channelRepository !== repository || body.currentVersion !== version || body.available !== Boolean(body.available)) {
    fail(`Update route returned the wrong strict channel identity: ${JSON.stringify(body)}`);
  }
  const installationKeys = ['currentVersion', 'error', 'previousVersion', 'schemaVersion', 'state', 'targetVersion', 'updatedAt'];
  if (!body.installation || JSON.stringify(Object.keys(body.installation).sort()) !== JSON.stringify(installationKeys)) {
    fail('Update route installation status has an invalid shape');
  }
  if (body.installation.schemaVersion !== 1 || body.installation.currentVersion !== version || !String(body.installation.updatedAt).endsWith('Z')) {
    fail('Update route installation status has the wrong identity');
  }

  if (body.noValidatedRelease === true) {
    const expected = body.reason === 'channel-base-older' ? [...commonKeys, 'noValidatedRelease', 'reason'] : [...commonKeys, 'noValidatedRelease'];
    if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected.sort())) fail('No-release update response has unexpected fields');
    if (body.available || (body.version !== null && !/^\d+\.\d+\.\d+-j2k\.[1-9]\d*$/.test(body.version))) fail('No-release update response is invalid');
    if (body.reason !== undefined && body.reason !== 'channel-base-older') fail('No-release update response has an invalid reason');
    if ((body.reason === undefined && body.version !== null) || body.installation.state !== 'no-validated-release') fail('No-release update status is inconsistent');
    return;
  }

  const expected = [...commonKeys, 'packageManager', 'releaseUrl', 'updateCommand'];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected.sort())) fail('Validated update response has unexpected fields');
  if (!/^\d+\.\d+\.\d+-j2k\.[1-9]\d*$/.test(body.version)) fail('Validated update response has an invalid version');
  if (body.packageManager !== 'validated-channel' || body.updateCommand !== 'openchamber update') fail('Validated update response has the wrong installer contract');
  if (body.releaseUrl !== `https://github.com/${repository}/releases/tag/v${body.version}`) fail('Validated update response has the wrong release URL');
  if (body.installation.state !== (body.available ? 'available' : 'installed')) fail('Validated update installation status is inconsistent');
}

function verifyMachO(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Native artifact is not a regular file: ${filePath}`);
  const identified = spawnSync('file', ['-b', filePath], { encoding: 'utf8', timeout: 5_000 });
  if (identified.status !== 0 || !identified.stdout.includes('Mach-O') || !identified.stdout.includes('arm64')) {
    fail(`Native artifact is not arm64 Mach-O: ${filePath}: ${identified.stdout || identified.stderr}`);
  }
  const architectures = spawnSync('lipo', ['-archs', filePath], { encoding: 'utf8', timeout: 5_000 });
  if (architectures.status !== 0 || architectures.stdout.trim() !== 'arm64') {
    fail(`Native artifact has unexpected architectures: ${filePath}: ${architectures.stdout || architectures.stderr}`);
  }
}

function exerciseNativeModules(installRoot, temporaryRoot) {
  const sherpaRoot = join(installRoot, 'node_modules', 'sherpa-onnx-darwin-arm64');
  for (const nativePath of [
    join(installRoot, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'),
    join(sherpaRoot, 'sherpa-onnx.node'),
    join(sherpaRoot, 'libonnxruntime.1.24.4.dylib'),
    join(sherpaRoot, 'libonnxruntime.dylib'),
    join(sherpaRoot, 'libsherpa-onnx-c-api.dylib'),
    join(sherpaRoot, 'libsherpa-onnx-cxx-api.dylib'),
  ]) verifyMachO(nativePath);

  const script = `
    const pty = require('node-pty');
    const sherpa = require('sherpa-onnx-node');
    if (typeof sherpa.version !== 'string' || !sherpa.version) throw new Error('Sherpa native binding did not expose a version');
    const terminal = pty.spawn('/bin/sh', ['-c', 'printf native-pty-ok'], { cols: 80, rows: 24, cwd: process.cwd(), env: { PATH: '/usr/bin:/bin' } });
    let output = '';
    const timer = setTimeout(() => { terminal.kill(); throw new Error('node-pty smoke timed out'); }, 5000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes('native-pty-ok')) throw new Error('node-pty smoke failed');
      process.stdout.write(JSON.stringify({ pty: true, sherpaVersion: sherpa.version }));
    });
  `;
  const native = spawnSync(process.execPath, ['-e', script], {
    cwd: installRoot,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: sherpaRoot,
      HOME: temporaryRoot,
      NODE_PATH: '',
    },
  });
  if (native.status !== 0) fail(`Native module smoke failed:\n${native.stdout}\n${native.stderr}`);
  const result = JSON.parse(native.stdout);
  if (result.pty !== true || !result.sherpaVersion) fail('Native module smoke returned an invalid result');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tarball = resolve(options.tarball || fail('Missing --tarball'));
  const version = options.version || fail('Missing --version');
  const sourceCommit = options['source-commit'] || fail('Missing --source-commit');
  const channelRepository = options['channel-repository'] || null;
  const target = validateArtifactTarget({
    platform: options.platform,
    arch: options.arch,
    nodeAbi: options['node-abi'],
  });
  if (process.platform !== target.platform || process.arch !== target.arch || process.versions.modules !== target.nodeAbi) {
    fail(`Smoke Node target ${process.platform}/${process.arch}/ABI-${process.versions.modules} does not match ${target.platform}/${target.arch}/ABI-${target.nodeAbi}`);
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'openchamber-channel-smoke-'));
  const installRoot = join(temporaryRoot, 'install');
  let child;
  const stub = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ healthy: true, version: 'smoke-stub', path: request.url }));
  });

  try {
    verifyRelocatableArchive(tarball, { expectedVersion: version, sourceCommit, target, extractDirectory: installRoot });

    const cli = join(installRoot, 'bin', 'cli.js');
    const reportedVersion = spawnSync(process.execPath, [cli, '--version'], {
      cwd: installRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '', npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9' },
    });
    if (reportedVersion.status !== 0 || reportedVersion.stdout.trim() !== version) {
      fail(`Installed CLI reported ${reportedVersion.stdout.trim() || '<empty>'}; expected ${version}`);
    }
    if (target.platform === 'darwin' && target.arch === 'arm64' && target.nodeAbi === '127') {
      exerciseNativeModules(installRoot, temporaryRoot);
    }

    const stubPort = await listen(stub);
    const reservation = createServer();
    const openchamberPort = await listen(reservation);
    await new Promise((resolvePromise) => reservation.close(resolvePromise));
    const logPath = join(temporaryRoot, 'openchamber.log');
    const logFd = await import('node:fs').then(({ openSync }) => openSync(logPath, 'w'));
    child = spawn(process.execPath, [cli, 'serve', '--foreground', '--port', String(openchamberPort)], {
      cwd: installRoot,
      env: {
        ...process.env,
        BUN_BINARY: join(temporaryRoot, 'missing-bun'),
        NODE_PATH: '',
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:9',
        OPENCODE_BINARY: process.execPath,
        OPENCODE_HOST: `http://127.0.0.1:${stubPort}`,
        OPENCODE_SKIP_START: 'true',
        OPENCHAMBER_HOST: '127.0.0.1',
        OPENCHAMBER_UI_PASSWORD: `channel-smoke-${sourceCommit.slice(0, 12)}`,
        OPENCHAMBER_UPDATE_CHANNEL_REPO: channelRepository || 'jameskorzekwa/openchamber',
      },
      stdio: ['ignore', logFd, logFd],
    });

    const origin = `http://127.0.0.1:${openchamberPort}`;
    const health = await (await waitFor(`${origin}/health`, child)).json();
    if (health.status !== 'ok' || health.openchamberVersion !== version) fail('Health response has the wrong release identity');
    const unauthenticated = await fetch(`${origin}/api/openchamber/update-check`, { signal: AbortSignal.timeout(5_000) });
    if (unauthenticated.status !== 401) fail(`Update route did not require authentication: ${unauthenticated.status}`);
    const password = `channel-smoke-${sourceCommit.slice(0, 12)}`;
    const login = await fetch(`${origin}/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(5_000),
    });
    const loginBody = await login.json();
    if (!login.ok || loginBody.authenticated !== true) fail(`Smoke authentication failed: ${login.status}`);
    const setCookies = login.headers.getSetCookie?.() || [login.headers.get('set-cookie')].filter(Boolean);
    const cookie = setCookies.map((value) => value.split(';', 1)[0]).join('; ');
    if (!cookie) fail('Smoke authentication did not issue a session cookie');

    const versionResponse = await fetch(`${origin}/api/version`, { headers: { cookie }, signal: AbortSignal.timeout(5_000) });
    const versionBody = await versionResponse.json();
    if (!versionResponse.ok || versionBody.openchamberVersion !== version) fail('Version endpoint has the wrong release identity');
    const revision = JSON.parse(readFileSync(join(installRoot, 'dist', 'build-revision.json'), 'utf8'));
    if (revision.revision !== sourceCommit) fail('Extracted build revision has the wrong source identity');

    const indexResponse = await fetch(`${origin}/index.html`);
    if (!indexResponse.ok) fail(`index.html returned ${indexResponse.status}`);
    const index = await indexResponse.text();
    const assetPaths = [...index.matchAll(/(?:src|href)="(\/assets\/[^"?]+)["?]/g)].map((match) => match[1]);
    if (assetPaths.length === 0) fail('index.html does not reference built assets');
    for (const assetPath of new Set(assetPaths)) {
      const asset = await fetch(`${origin}${assetPath}`);
      if (!asset.ok) fail(`Built asset ${assetPath} returned ${asset.status}`);
    }

    if (channelRepository) {
      if (channelRepository !== 'jameskorzekwa/openchamber') fail(`Unexpected strict channel repository: ${channelRepository}`);
      const update = await fetch(`${origin}/api/openchamber/update-check?appType=web`, {
        headers: { cookie },
        signal: AbortSignal.timeout(75_000),
      });
      const updateBody = await update.json();
      if (!update.ok) fail(`Strict channel update check failed: ${update.status}: ${JSON.stringify(updateBody)}`);
      assertChannelResponse(updateBody, { version, repository: channelRepository });
    }

  } catch (error) {
    if (child) child.kill('SIGTERM');
    const logs = (() => {
      try { return readFileSync(join(temporaryRoot, 'openchamber.log'), 'utf8'); } catch { return ''; }
    })();
    if (logs) console.error(logs);
    throw error;
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await new Promise((resolvePromise) => stub.close(resolvePromise));
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
