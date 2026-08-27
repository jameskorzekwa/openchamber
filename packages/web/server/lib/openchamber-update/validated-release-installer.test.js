import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createValidatedReleaseInstaller,
  ensureDirectoryDurable,
  validateChannelMetadata,
} from './validated-release-installer.js';

const BASE_VERSION = '2.0.0';
const VERSION = `${BASE_VERSION}-j2k.1`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const OLD_COMMIT = '1111111111111111111111111111111111111111';
const UPSTREAM_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NODE_ABI = process.versions.modules;
const TAG = `v${VERSION}`;
const ARCHIVE_NAME = `openchamber-web-${VERSION}.tgz`;
const DEPENDENCIES = { 'fixture-dependency': '^1.0.0' };
const RELEASE_ROOT = `https://github.com/jameskorzekwa/openchamber/releases/download/${TAG}`;
const temporaryDirectories = [];

function writeTarString(header, offset, length, value) {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeTarOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarEntry(name, content = Buffer.alloc(0), type = '0', mode = 0o644, declaredSize) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, declaredSize ?? data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  return `${length} ${body}`;
}

function makeArchive(extraEntries = [], includeDependencies = true) {
  const entries = [
    tarEntry('package/', Buffer.alloc(0), '5', 0o755),
    tarEntry('package/package.json', JSON.stringify({
      name: '@openchamber/web',
      version: VERSION,
      dependencies: DEPENDENCIES,
      openchamberArtifact: { platform: 'darwin', arch: 'arm64', nodeAbi: NODE_ABI },
    })),
    tarEntry('package/dist/', Buffer.alloc(0), '5', 0o755),
    tarEntry('package/dist/build-revision.json', JSON.stringify({ revision: COMMIT })),
    tarEntry('package/dist/index.html', '<!doctype html>'),
    tarEntry('package/bin/', Buffer.alloc(0), '5', 0o755),
    tarEntry('package/bin/cli.js', '#!/usr/bin/env node\n', '0', 0o755),
    tarEntry('package/server/', Buffer.alloc(0), '5', 0o755),
    tarEntry('package/server/index.js', 'export {};'),
    ...(includeDependencies ? [
      tarEntry('package/node_modules/', Buffer.alloc(0), '5', 0o755),
      tarEntry('package/node_modules/fixture-dependency/', Buffer.alloc(0), '5', 0o755),
      tarEntry('package/node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', os: ['darwin'], cpu: ['arm64'], peerDependencies: { 'fixture-peer': '^1.0.0' } })),
      tarEntry('package/node_modules/fixture-peer/', Buffer.alloc(0), '5', 0o755),
      tarEntry('package/node_modules/fixture-peer/package.json', JSON.stringify({ name: 'fixture-peer', version: '1.0.0' })),
    ] : []),
    ...extraEntries,
    Buffer.alloc(1024),
  ];
  return zlib.gzipSync(Buffer.concat(entries));
}

function makeChannel(archive, overrides = {}) {
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  return {
    schema: 1,
    baseVersion: BASE_VERSION,
    channelRevision: 1,
    version: VERSION,
    releaseTag: TAG,
    tarball: ARCHIVE_NAME,
    checksumAsset: 'SHA256SUMS',
    manifestAsset: 'channel.json',
    assets: [ARCHIVE_NAME, 'SHA256SUMS', 'channel.json'],
    sha256,
    upstreamTag: `v${BASE_VERSION}`,
    seriesHead: COMMIT,
    sourceCommit: COMMIT,
    minNode: '22',
    platform: 'darwin',
    arch: 'arm64',
    nodeAbi: NODE_ABI,
    ...overrides,
  };
}

function makeRelease(channel, archive) {
  return {
    tag_name: TAG,
    target_commitish: COMMIT,
    assets: [
      { name: 'channel.json', browser_download_url: `${RELEASE_ROOT}/channel.json`, size: 500 },
      { name: ARCHIVE_NAME, browser_download_url: `${RELEASE_ROOT}/${ARCHIVE_NAME}`, size: archive.length },
      { name: 'SHA256SUMS', browser_download_url: `${RELEASE_ROOT}/SHA256SUMS`, size: 100 },
    ],
  };
}

function makeFetch({ archive, channel, checksum, releaseStatus = 200, overrides = new Map() } = {}) {
  const actualArchive = archive || makeArchive();
  const actualChannel = channel || makeChannel(actualArchive);
  const release = makeRelease(actualChannel, actualArchive);
  const checksumBody = checksum || `${actualChannel.sha256}  ${ARCHIVE_NAME}\n`;
  const responses = new Map([
    ['https://api.github.com/repos/jameskorzekwa/openchamber/releases/latest', JSON.stringify(release)],
    [`https://api.github.com/repos/jameskorzekwa/openchamber/commits/${TAG}`, JSON.stringify({ sha: COMMIT })],
    [`https://api.github.com/repos/openchamber/openchamber/commits/v${BASE_VERSION}`, JSON.stringify({ sha: UPSTREAM_COMMIT })],
    [`https://api.github.com/repos/jameskorzekwa/openchamber/compare/${UPSTREAM_COMMIT}...${COMMIT}`, JSON.stringify({ status: 'ahead', merge_base_commit: { sha: UPSTREAM_COMMIT } })],
    [`${RELEASE_ROOT}/channel.json`, JSON.stringify(actualChannel)],
    [`${RELEASE_ROOT}/SHA256SUMS`, checksumBody],
    [`${RELEASE_ROOT}/${ARCHIVE_NAME}`, actualArchive],
  ]);
  for (const [url, response] of overrides) responses.set(url, response);
  return vi.fn(async (url) => {
    const body = responses.get(String(url));
    if (String(url).endsWith('/releases/latest') && releaseStatus !== 200) return new Response('missing', { status: releaseStatus });
    if (body instanceof Response) return body;
    if (body instanceof Function) return body();
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
  });
}

async function makeHarness(fetchImpl = makeFetch(), onStateChange, installerOptions = {}) {
  let root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-update-'));
  root = await fsp.realpath(root);
  temporaryDirectories.push(root);
  const installRoot = path.join(root, 'install');
  let oldInstall = path.join(root, 'old');
  await fsp.mkdir(oldInstall, { recursive: true });
  oldInstall = await fsp.realpath(oldInstall);
  await fsp.writeFile(path.join(oldInstall, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '1.0.0', dependencies: DEPENDENCIES }));
  await fsp.mkdir(path.join(oldInstall, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(oldInstall, 'dist', 'build-revision.json'), JSON.stringify({ revision: OLD_COMMIT }));
  await fsp.mkdir(path.join(oldInstall, 'node_modules', 'fixture-dependency'), { recursive: true });
  await fsp.writeFile(path.join(oldInstall, 'node_modules', 'fixture-dependency', 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', peerDependencies: { 'fixture-peer': '^1.0.0' } }));
  await fsp.mkdir(path.join(oldInstall, 'node_modules', 'fixture-peer'), { recursive: true });
  await fsp.writeFile(path.join(oldInstall, 'node_modules', 'fixture-peer', 'package.json'), JSON.stringify({ name: 'fixture-peer', version: '1.0.0' }));
  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.symlink(oldInstall, path.join(installRoot, 'current'));
  const installer = createValidatedReleaseInstaller({
    fetchImpl,
    installRoot,
    currentInstallDir: oldInstall,
    currentVersion: '1.0.0',
    onStateChange,
    platform: 'darwin',
    arch: 'arm64',
    nodeAbi: NODE_ABI,
    ...installerOptions,
  });
  return { root, installRoot, oldInstall, installer };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

describe('validated release metadata', () => {
  it.each([
    ['schema', { schema: 2 }, 'schema'],
    ['channel', { version: `${BASE_VERSION}-other.1` }, 'channel identity'],
    ['revision', { channelRevision: 2 }, 'channel identity'],
    ['tag', { releaseTag: 'v9.9.9' }, 'release tag'],
    ['version', { baseVersion: '../2.0.0' }, 'base version'],
    ['commit', { sourceCommit: 'f'.repeat(40) }, 'source commit'],
    ['archive identity', { tarball: 'other.tgz' }, 'archive name'],
    ['platform', { platform: 'linux' }, 'does not match'],
  ])('rejects an identity-mismatched %s', (_label, override, message) => {
    const archive = makeArchive();
    const channel = makeChannel(archive, override);
    expect(() => validateChannelMetadata(channel, { tag: TAG, targetCommitish: COMMIT, assets: [] }, COMMIT, { platform: 'darwin', arch: 'arm64', nodeAbi: NODE_ABI })).toThrow(message);
  });
});

describe('validated release installation', () => {
  it('durably creates every missing ancestor in a nested install path', async () => {
    let root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-durable-dir-')));
    temporaryDirectories.push(root);
    const nested = path.join(root, 'one', 'two', 'three');
    await ensureDirectoryDurable(nested);
    expect((await fsp.stat(path.join(root, 'one'))).isDirectory()).toBe(true);
    expect((await fsp.stat(path.join(root, 'one', 'two'))).isDirectory()).toBe(true);
    expect((await fsp.stat(nested)).isDirectory()).toBe(true);
  });
  it('rejects a checksum mismatch without switching the current install', async () => {
    const harness = await makeHarness(makeFetch({ checksum: `${'f'.repeat(64)}  ${ARCHIVE_NAME}\n` }));
    await expect(harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('Checksum asset does not match');
    expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(harness.oldInstall);
    expect(harness.installer.getStatus().state).toBe('failed');
  });

  it('rejects traversal and symlink archive entries', async () => {
    for (const unsafeEntry of [
      tarEntry('package/../../escape', 'owned'),
      tarEntry('package/link', '../outside', '2'),
    ]) {
      const archive = makeArchive([unsafeEntry]);
      const harness = await makeHarness(makeFetch({ archive, channel: makeChannel(archive) }));
      await expect(harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow(/unsafe path|not allowed/);
      await expect(fsp.stat(path.join(harness.root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(harness.oldInstall);
    }
  });

  it.each([
    ['hardlink', tarEntry('package/hard', 'package/package.json', '1')],
    ['character device', tarEntry('package/device', '', '3')],
    ['block device', tarEntry('package/device', '', '4')],
    ['fifo', tarEntry('package/fifo', '', '6')],
    ['duplicate', tarEntry('package/package.json', '{}')],
    ['oversized file', tarEntry('package/large', '', '0', 0o644, 128 * 1024 * 1024 + 1)],
  ])('rejects %s archive entries', async (_label, unsafeEntry) => {
    const archive = makeArchive([unsafeEntry]);
    const harness = await makeHarness(makeFetch({ archive, channel: makeChannel(archive) }));
    await expect(harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow(/not allowed|duplicate|per-file limit/);
    expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(harness.oldInstall);
  });

  it('supports bounded PAX and GNU long paths while rejecting unsupported PAX overrides', async () => {
    const paxPath = 'package/docs/pax-name.txt';
    const gnuPath = `package/docs/${'g'.repeat(110)}.txt`;
    const archive = makeArchive([
      tarEntry('PaxHeader', paxRecord('path', paxPath), 'x'),
      tarEntry('ignored-pax-name', 'pax'),
      tarEntry('././@LongLink', `${gnuPath}\0`, 'L'),
      tarEntry('ignored-gnu-name', 'gnu'),
    ]);
    const harness = await makeHarness(makeFetch({ archive, channel: makeChannel(archive) }));
    await harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() });
    const selected = await fsp.realpath(path.join(harness.installRoot, 'current'));
    expect(await fsp.readFile(path.join(selected, 'docs', 'pax-name.txt'), 'utf8')).toBe('pax');
    expect(await fsp.readFile(path.join(selected, 'docs', `${'g'.repeat(110)}.txt`), 'utf8')).toBe('gnu');

    const unsafe = makeArchive([tarEntry('PaxHeader', paxRecord('size', '1'), 'x'), tarEntry('package/nope', 'x')]);
    const unsafeHarness = await makeHarness(makeFetch({ archive: unsafe, channel: makeChannel(unsafe) }));
    await expect(unsafeHarness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('unsupported PAX metadata');
  });

  it('enforces the redirect hop limit', async () => {
    const archive = makeArchive();
    const archiveUrl = `${RELEASE_ROOT}/${ARCHIVE_NAME}`;
    const overrides = new Map();
    for (let index = 0; index <= 6; index += 1) {
      const source = index === 0 ? archiveUrl : `https://release-assets.githubusercontent.com/archive?hop=${index}`;
      const destination = `https://release-assets.githubusercontent.com/archive?hop=${index + 1}`;
      overrides.set(source, () => new Response(null, { status: 302, headers: { Location: destination } }));
    }
    const harness = await makeHarness(makeFetch({ archive, overrides }));
    await expect(harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('redirect limit');
  });

  it('fails closed when no validated release exists', async () => {
    const harness = await makeHarness(makeFetch({ releaseStatus: 404 }));
    await expect(harness.installer.checkForUpdate()).resolves.toMatchObject({ available: false, noValidatedRelease: true });
    expect(harness.installer.getStatus().state).toBe('no-validated-release');
  });

  it('clears stale no-validated-release after validating the exact running channel', async () => {
    const validFetch = makeFetch();
    let releaseMissing = true;
    const fetchImpl = vi.fn((url, options) => {
      if (releaseMissing && String(url).endsWith('/releases/latest')) return Promise.resolve(new Response('missing', { status: 404 }));
      return validFetch(url, options);
    });
    const harness = await makeHarness(fetchImpl, undefined, { currentVersion: VERSION });
    await harness.installer.checkForUpdate();
    expect(harness.installer.getStatus().state).toBe('no-validated-release');
    releaseMissing = false;
    await expect(harness.installer.checkForUpdate()).resolves.toMatchObject({ available: false, version: VERSION });
    expect(harness.installer.getStatus()).toMatchObject({ state: 'installed', currentVersion: VERSION });
  });

  it('reports no validated release when the latest channel base is older than the running base', async () => {
    const harness = await makeHarness(makeFetch(), undefined, { currentVersion: '3.0.0' });
    await expect(harness.installer.checkForUpdate()).resolves.toMatchObject({ available: false, noValidatedRelease: true, reason: 'channel-base-older' });
    expect(harness.installer.getStatus().state).toBe('no-validated-release');
  });

  it('rejects an otherwise valid artifact without bundled production dependencies', async () => {
    const archive = makeArchive([], false);
    const harness = await makeHarness(makeFetch({ archive, channel: makeChannel(archive) }));
    await expect(harness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('does not bundle production node_modules');
    expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(harness.oldInstall);
  });

  it('rejects source commits that do not descend from the claimed upstream tag', async () => {
    const compareUrl = `https://api.github.com/repos/jameskorzekwa/openchamber/compare/${UPSTREAM_COMMIT}...${COMMIT}`;
    const fetchImpl = makeFetch({ overrides: new Map([[compareUrl, JSON.stringify({ status: 'diverged', merge_base_commit: { sha: 'b'.repeat(40) } })]]) });
    const harness = await makeHarness(fetchImpl);
    await expect(harness.installer.checkForUpdate()).rejects.toThrow('does not prove ancestry');
  });

  it('allows bounded GitHub asset redirects and rejects other destinations', async () => {
    const archive = makeArchive();
    const archiveUrl = `${RELEASE_ROOT}/${ARCHIVE_NAME}`;
    const cdnUrl = 'https://release-assets.githubusercontent.com/signed/archive';
    const allowed = makeFetch({ archive, overrides: new Map([
      [archiveUrl, () => new Response(null, { status: 302, headers: { Location: cdnUrl } })],
      [cdnUrl, archive],
    ]) });
    const allowedHarness = await makeHarness(allowed);
    await expect(allowedHarness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).resolves.toMatchObject({ state: 'restarting' });

    const rejected = makeFetch({ overrides: new Map([[`${RELEASE_ROOT}/SHA256SUMS`, () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/archive' } })]]) });
    const rejectedHarness = await makeHarness(rejected);
    await expect(rejectedHarness.installer.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('redirect destination is not allowed');
  });

  it('sends an optional token only to the GitHub API', async () => {
    const requests = [];
    const baseFetch = makeFetch();
    const fetchImpl = vi.fn((url, options) => {
      requests.push({ url: String(url), authorization: options?.headers?.Authorization });
      return baseFetch(url, options);
    });
    const harness = await makeHarness(fetchImpl, undefined, { githubToken: 'test-token' });
    await harness.installer.checkForUpdate();

    expect(requests.filter((request) => request.url.startsWith('https://api.github.com/'))
      .every((request) => request.authorization === 'Bearer test-token')).toBe(true);
    expect(requests.filter((request) => !request.url.startsWith('https://api.github.com/'))
      .every((request) => request.authorization === undefined)).toBe(true);
  });

  it('rolls back the current symlink when restart handoff fails', async () => {
    const harness = await makeHarness();
    await expect(harness.installer.install({
      targetVersion: VERSION,
      handoffRestart: vi.fn(async () => {
        await fsp.rm(harness.oldInstall, { recursive: true, force: true });
        throw new Error('manager unavailable');
      }),
    })).rejects.toThrow('manager unavailable');
    const rollbackTarget = await fsp.realpath(path.join(harness.installRoot, 'current'));
    expect(rollbackTarget).toContain(path.join(harness.installRoot, 'archives'));
    expect(JSON.parse(await fsp.readFile(path.join(rollbackTarget, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(JSON.parse(await fsp.readFile(path.join(rollbackTarget, 'node_modules', 'fixture-dependency', 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect((await fsp.readdir(path.join(harness.installRoot, 'archives'))).length).toBe(1);
    expect(harness.installer.getStatus()).toMatchObject({ state: 'rollback', error: 'manager unavailable' });
  });

  it.each([
    ['before-restart-journal', false, false],
    ['after-restart-journal', true, false],
    ['after-release-selection', true, true],
  ])('preserves recoverable state after a simulated crash at %s', async (stage, journalExpected, targetSelected) => {
    const crash = Object.assign(new Error(`crash at ${stage}`), { code: 'SIMULATED_PROCESS_CRASH' });
    const harness = await makeHarness(makeFetch(), undefined, {
      faultInjector: (currentStage) => {
        if (currentStage === stage) throw crash;
      },
    });
    const transactionPath = path.join(harness.installRoot, 'restart-transaction.json');
    await expect(harness.installer.install({
      targetVersion: VERSION,
      prepareRestart: async () => {
        await fsp.writeFile(transactionPath, JSON.stringify({ phase: 'prepared' }));
        return { transactionPath };
      },
      handoffRestart: vi.fn(),
    })).rejects.toThrow(`crash at ${stage}`);
    expect(await fsp.stat(transactionPath).then(() => true).catch(() => false)).toBe(journalExpected);
    const selected = await fsp.realpath(path.join(harness.installRoot, 'current'));
    expect(selected === harness.oldInstall).toBe(!targetSelected);
    if (targetSelected) expect(JSON.parse(await fsp.readFile(path.join(harness.installRoot, 'update-status.json'), 'utf8')).state).toBe('restarting');
  });

  it('cancels the prepared journal and restores selection when primary helper launch fails', async () => {
    const harness = await makeHarness();
    const transactionPath = path.join(harness.installRoot, 'restart-transaction.json');
    const cancelRestart = vi.fn(async () => fsp.rm(transactionPath, { force: true }));
    await expect(harness.installer.install({
      targetVersion: VERSION,
      prepareRestart: async () => {
        await fsp.writeFile(transactionPath, JSON.stringify({ phase: 'prepared' }));
        return { transactionPath };
      },
      handoffRestart: async () => { throw new Error('helper spawn failed'); },
      cancelRestart,
    })).rejects.toThrow('helper spawn failed');
    const restored = await fsp.realpath(path.join(harness.installRoot, 'current'));
    expect(restored).toContain(path.join(harness.installRoot, 'archives'));
    expect(JSON.parse(await fsp.readFile(path.join(restored, 'package.json'), 'utf8')).version).toBe('1.0.0');
    await expect(fsp.access(transactionPath)).rejects.toThrow();
    expect(cancelRestart).toHaveBeenCalledOnce();
  });

  it('rejects admission while a restart journal still exists', async () => {
    const harness = await makeHarness();
    const transactionPath = path.join(harness.installRoot, 'restart-transaction.json');
    await fsp.writeFile(transactionPath, '{"phase":"failed"}\n');
    await expect(harness.installer.beginInstall({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('restart transaction is still pending');
    expect(harness.installer.getStatus().state).toBe('installed');
  });

  it('persists failed only after cancellation restoration fails', async () => {
    const harness = await makeHarness();
    const transactionPath = path.join(harness.installRoot, 'restart-transaction.json');
    const cancelRestart = vi.fn(async () => {
      expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).not.toContain(path.join(harness.installRoot, 'releases'));
      expect(JSON.parse(await fsp.readFile(path.join(harness.installRoot, 'update-status.json'), 'utf8')).state).toBe('restarting');
      throw new Error('service restore failed');
    });
    await expect(harness.installer.install({
      targetVersion: VERSION,
      prepareRestart: async () => {
        await fsp.writeFile(transactionPath, JSON.stringify({ phase: 'prepared' }));
        return { transactionPath };
      },
      handoffRestart: async () => { throw new Error('helper spawn failed'); },
      cancelRestart,
    })).rejects.toThrow('helper spawn failed');
    expect(harness.installer.getStatus()).toMatchObject({ state: 'failed', error: expect.stringContaining('service restore failed') });
    await expect(fsp.access(transactionPath)).resolves.toBeUndefined();
  });

  it('never reuses a tampered deterministic release directory', async () => {
    const harness = await makeHarness();
    await expect(harness.installer.install({
      targetVersion: VERSION,
      handoffRestart: vi.fn(async () => { throw new Error('first handoff failed'); }),
    })).rejects.toThrow('first handoff failed');
    const releaseDirectory = path.join(harness.installRoot, 'releases', `${VERSION}-${COMMIT.slice(0, 12)}`);
    await fsp.writeFile(path.join(releaseDirectory, 'server', 'index.js'), 'tampered');
    const selectedBeforeRetry = await fsp.realpath(path.join(harness.installRoot, 'current'));
    const retry = createValidatedReleaseInstaller({
      fetchImpl: makeFetch(),
      installRoot: harness.installRoot,
      currentInstallDir: selectedBeforeRetry,
      currentVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      nodeAbi: NODE_ABI,
    });
    await expect(retry.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('differs from the checksum-verified artifact');
    expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(selectedBeforeRetry);
  });

  it('stages, switches atomically, preserves rollback, and reconciles installed after restart', async () => {
    const transitions = [];
    const harness = await makeHarness(makeFetch(), (status) => transitions.push(status.state));
    await expect(harness.installer.checkForUpdate()).resolves.toMatchObject({
      available: true,
      version: VERSION,
      channel: 'j2k',
      channelRepository: 'jameskorzekwa/openchamber',
    });
    const handoffRestart = vi.fn();
    await harness.installer.install({ targetVersion: VERSION, handoffRestart });

    const currentTarget = await fsp.realpath(path.join(harness.installRoot, 'current'));
    expect(currentTarget).toContain(path.join('releases', `${VERSION}-${COMMIT.slice(0, 12)}`));
    const previousTarget = await fsp.realpath(path.join(harness.installRoot, 'previous'));
    expect(previousTarget).toContain(path.join(harness.installRoot, 'archives'));
    expect(JSON.parse(await fsp.readFile(path.join(previousTarget, 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect((await fsp.readdir(path.join(harness.installRoot, 'archives'))).length).toBe(1);
    expect(JSON.parse(await fsp.readFile(path.join(currentTarget, 'package.json'), 'utf8')).version).toBe(VERSION);
    expect(JSON.parse(await fsp.readFile(path.join(currentTarget, 'node_modules', 'fixture-dependency', 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(JSON.parse(await fsp.readFile(path.join(previousTarget, 'node_modules', 'fixture-dependency', 'node_modules', 'fixture-peer', 'package.json'), 'utf8')).version).toBe('1.0.0');
    expect(transitions).toEqual(['downloading', 'installing', 'restarting']);
    expect(handoffRestart).toHaveBeenCalledOnce();

    await fsp.writeFile(path.join(harness.installRoot, 'update-status.json'), JSON.stringify({
      schemaVersion: 1,
      state: 'installing',
      currentVersion: '1.0.0',
      targetVersion: VERSION,
      previousVersion: '1.0.0',
      error: null,
      updatedAt: '2026-08-26T00:00:00.000Z',
    }));
    await fsp.writeFile(path.join(harness.installRoot, 'restart-transaction.json'), '{}');
    const staleRestart = createValidatedReleaseInstaller({
      fetchImpl: makeFetch(),
      installRoot: harness.installRoot,
      currentInstallDir: harness.oldInstall,
      currentVersion: '1.0.0',
    });
    expect(staleRestart.getStatus()).toMatchObject({ state: 'restarting', targetVersion: VERSION });
    await fsp.rm(path.join(harness.installRoot, 'restart-transaction.json'));

    const restarted = createValidatedReleaseInstaller({
      fetchImpl: makeFetch(),
      installRoot: harness.installRoot,
      currentInstallDir: currentTarget,
      currentVersion: VERSION,
    });
    expect(restarted.getStatus()).toMatchObject({ state: 'failed', currentVersion: VERSION, targetVersion: VERSION, error: 'OpenChamber update restart transaction is missing' });
    await fsp.writeFile(path.join(harness.installRoot, 'update-status.json'), JSON.stringify({
      schemaVersion: 1,
      state: 'installed',
      currentVersion: VERSION,
      targetVersion: VERSION,
      previousVersion: '1.0.0',
      error: null,
      updatedAt: '2026-08-26T00:01:00.000Z',
    }));
    expect(restarted.getStatus()).toMatchObject({ state: 'installed', currentVersion: VERSION, targetVersion: VERSION });
  });

  it('serializes installer instances and recovers a stale host-independent lock directory', async () => {
    let releaseHandoff;
    const handoffWait = new Promise((resolve) => { releaseHandoff = resolve; });
    const observedStates = [];
    let harness;
    harness = await makeHarness(makeFetch(), () => observedStates.push(harness.installer.getStatus().state));
    const second = createValidatedReleaseInstaller({
      fetchImpl: makeFetch(),
      installRoot: harness.installRoot,
      currentInstallDir: harness.oldInstall,
      currentVersion: '1.0.0',
    });
    const firstInstall = harness.installer.install({ targetVersion: VERSION, handoffRestart: () => handoffWait });
    await vi.waitFor(() => expect(harness.installer.getStatus().state).toBe('restarting'));
    await expect(second.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).rejects.toThrow('owns the installation lock');
    const selectedBeforeRelease = await fsp.realpath(path.join(harness.installRoot, 'current'));
    releaseHandoff();
    await firstInstall;
    expect(await fsp.realpath(path.join(harness.installRoot, 'current'))).toBe(selectedBeforeRelease);
    expect(observedStates).not.toContain('failed');

    const old = new Date(Date.now() - 31 * 60 * 1000);
    const staleRoot = path.join(harness.root, 'stale-install');
    await fsp.mkdir(path.join(staleRoot, 'update.lock'), { recursive: true });
    await fsp.utimes(path.join(staleRoot, 'update.lock'), old, old);
    const staleRecovery = createValidatedReleaseInstaller({
      fetchImpl: makeFetch(),
      installRoot: staleRoot,
      currentInstallDir: harness.oldInstall,
      currentVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      nodeAbi: NODE_ABI,
    });
    await expect(staleRecovery.install({ targetVersion: VERSION, handoffRestart: vi.fn() })).resolves.toMatchObject({ state: 'restarting' });
  });
});
