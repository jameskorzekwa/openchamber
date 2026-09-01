import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import properLockfile from 'proper-lockfile';

const SCHEMA_VERSION = 1;
const CHANNEL_ID = 'j2k';
const REPOSITORY = 'jameskorzekwa/openchamber';
const INSTALL_ROOT = path.join(os.homedir(), '.local', 'share', 'openchamber');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANNEL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-j2k\.([1-9]\d*)$/;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_TAR_METADATA_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const TAR_BLOCK_SIZE = 512;
const MODULE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ACTIVE_STATES = new Set(['downloading', 'installing']);
const INSTALL_STATES = new Set([
  'available',
  'downloading',
  'installing',
  'restarting',
  'installed',
  'failed',
  'rollback',
  'no-validated-release',
]);

class NoValidatedReleaseError extends Error {
  constructor() {
    super('No validated OpenChamber release is available');
    this.name = 'NoValidatedReleaseError';
  }
}

function fail(message) {
  throw new Error(message);
}

export function resolveManagedInstallRoot(input = INSTALL_ROOT) {
  const absolute = path.resolve(input);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return path.join(resolveManagedInstallRoot(path.dirname(absolute)), path.basename(absolute));
  }
}

function isPlainObject(value) {
  return value === Object(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const isString = (value) => String(value) === value;

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRelease(raw) {
  if (!isPlainObject(raw) || !isString(raw.tag_name) || !isString(raw.target_commitish) || !Array.isArray(raw.assets)) {
    fail('GitHub release metadata is malformed');
  }
  const assets = raw.assets.map((asset) => {
    if (!isPlainObject(asset) || !isString(asset.name) || !isString(asset.browser_download_url) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      fail('GitHub release asset metadata is malformed');
    }
    return { name: asset.name, url: asset.browser_download_url, size: asset.size };
  });
  return { tag: raw.tag_name, targetCommitish: raw.target_commitish, assets };
}

function parseTagCommit(raw) {
  if (!isPlainObject(raw) || !isString(raw.sha) || !COMMIT_PATTERN.test(raw.sha)) {
    fail('GitHub tag commit metadata is malformed');
  }
  return raw.sha;
}

export function validateChannelMetadata(raw, release, tagCommit, target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules }) {
  const keys = [
    'schema', 'baseVersion', 'channelRevision', 'version', 'releaseTag', 'tarball',
    'checksumAsset', 'manifestAsset', 'assets', 'sha256', 'upstreamTag',
    'seriesHead', 'sourceCommit', 'minNode', 'platform', 'arch', 'nodeAbi',
  ];
  if (!hasExactKeys(raw, keys)) {
    fail('Update channel metadata has an invalid schema');
  }
  if (raw.schema !== SCHEMA_VERSION) fail('Unsupported update channel schema');
  if (!isString(raw.baseVersion) || !BASE_VERSION_PATTERN.test(raw.baseVersion)) fail('Update channel base version is invalid');
  if (!Number.isSafeInteger(raw.channelRevision) || raw.channelRevision < 1) fail('Update channel revision is invalid');
  if (!isString(raw.version) || !CHANNEL_VERSION_PATTERN.test(raw.version) || raw.version !== `${raw.baseVersion}-j2k.${raw.channelRevision}`) {
    fail('Update channel identity or version is invalid');
  }
  if (raw.releaseTag !== `v${raw.version}` || raw.releaseTag !== release.tag) fail('Update channel release tag does not match the GitHub release');
  if (!isString(raw.sourceCommit) || !COMMIT_PATTERN.test(raw.sourceCommit) || raw.sourceCommit !== tagCommit) {
    fail('Update channel source commit does not match the GitHub tag');
  }
  if (raw.seriesHead !== raw.sourceCommit) fail('Update channel series head does not match its source commit');
  if (raw.upstreamTag !== `v${raw.baseVersion}`) fail('Update channel upstream tag does not match its base version');
  if (COMMIT_PATTERN.test(release.targetCommitish) && release.targetCommitish !== raw.sourceCommit) {
    fail('GitHub release target commit does not match the update channel');
  }
  const expectedArchiveName = `openchamber-web-${raw.version}.tgz`;
  if (raw.tarball !== expectedArchiveName) fail('Update channel archive name does not match its version');
  if (raw.checksumAsset !== 'SHA256SUMS' || raw.manifestAsset !== 'channel.json') fail('Update channel asset names are invalid');
  if (!Array.isArray(raw.assets) || raw.assets.length !== 3 || raw.assets[0] !== expectedArchiveName || raw.assets[1] !== 'SHA256SUMS' || raw.assets[2] !== 'channel.json') {
    fail('Update channel asset inventory is invalid');
  }
  if (!isString(raw.sha256) || !SHA256_PATTERN.test(raw.sha256)) fail('Update channel SHA-256 is invalid');
  if (raw.minNode !== '22') fail('Update channel minimum Node version is unsupported');
  if (raw.platform !== target.platform || raw.arch !== target.arch || raw.nodeAbi !== target.nodeAbi) {
    fail(`Update channel target ${raw.platform}/${raw.arch}/ABI-${raw.nodeAbi} does not match ${target.platform}/${target.arch}/ABI-${target.nodeAbi}`);
  }
  return {
    schema: SCHEMA_VERSION,
    channel: CHANNEL_ID,
    repository: REPOSITORY,
    baseVersion: raw.baseVersion,
    channelRevision: raw.channelRevision,
    releaseTag: raw.releaseTag,
    version: raw.version,
    upstreamTag: raw.upstreamTag,
    sourceCommit: raw.sourceCommit,
    platform: raw.platform,
    arch: raw.arch,
    nodeAbi: raw.nodeAbi,
    assets: [...raw.assets],
    archive: {
      name: raw.tarball,
      checksumName: raw.checksumAsset,
      sha256: raw.sha256,
    },
  };
}

function getUniqueAsset(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) fail(`Expected exactly one ${name} GitHub Release asset`);
  return matches[0];
}

function validateAssetUrl(asset, releaseTag, repository = REPOSITORY) {
  let url;
  try {
    url = new URL(asset.url);
  } catch {
    fail(`GitHub Release asset ${asset.name} has an invalid URL`);
  }
  const expectedPath = `/${repository}/releases/download/${releaseTag}/${asset.name}`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || decodeURIComponent(url.pathname) !== expectedPath || url.search || url.hash) {
    fail(`GitHub Release asset ${asset.name} has an unexpected identity`);
  }
}

async function readResponseBytes(response, limit, label) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) fail(`${label} exceeds the download limit`);
  if (!response.body) fail(`${label} response has no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      fail(`${label} exceeds the download limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

const ASSET_REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function validateFetchUrl(value, mode, initialUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('GitHub redirect destination is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('GitHub redirect destination is not allowed');
  if (mode === 'api') {
    if (url.hostname !== 'api.github.com' || url.origin !== initialUrl.origin || !url.pathname.startsWith('/repos/')) {
      fail('GitHub API redirect destination is not allowed');
    }
  } else if (!ASSET_REDIRECT_HOSTS.has(url.hostname)) {
    fail('GitHub asset redirect destination is not allowed');
  }
  return url;
}

async function fetchWithRedirects(fetchImpl, value, label, options = {}) {
  const initialUrl = new URL(value);
  const mode = initialUrl.hostname === 'api.github.com' ? 'api' : 'asset';
  const signal = AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS);
  let url = validateFetchUrl(initialUrl, mode, initialUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers = { Accept: mode === 'api' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'openchamber-validated-updater' };
    if (mode === 'api' && options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
    const response = await fetchImpl(url.href, {
      headers,
      signal,
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirectCount === MAX_REDIRECTS) fail(`${label} exceeded the redirect limit`);
    const location = response.headers.get('location');
    if (!location) fail(`${label} returned a redirect without a destination`);
    url = validateFetchUrl(new URL(location, url), mode, initialUrl);
  }
  fail(`${label} exceeded the redirect limit`);
}

async function fetchBytes(fetchImpl, url, limit, label, options = {}) {
  const response = await fetchWithRedirects(fetchImpl, url, label, options);
  if (options.noReleaseOn404 && response.status === 404) throw new NoValidatedReleaseError();
  if (!response.ok) fail(`${label} request failed with ${response.status}`);
  return readResponseBytes(response, limit, label);
}

async function fetchJson(fetchImpl, url, label, options) {
  const bytes = await fetchBytes(fetchImpl, url, 1024 * 1024, label, options);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function parseChecksumFile(bytes, archiveName) {
  const match = bytes.toString('utf8').match(/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)\n?$/);
  if (!match || match[2] !== archiveName) fail('Checksum asset is malformed or names a different archive');
  return match[1];
}

function parseTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}

function parseTarNumber(buffer, start, length) {
  if ((buffer[start] & 0x80) !== 0) fail('Base-256 tar numbers are not supported');
  const raw = parseTarString(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) fail('Archive contains an invalid tar number');
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('Archive contains an invalid tar number');
  return value;
}

function verifyTarHeader(buffer, offset) {
  const stored = parseTarNumber(buffer, offset + 148, 8);
  let calculated = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    calculated += index >= 148 && index < 156 ? 32 : buffer[offset + index];
  }
  if (stored !== calculated) fail('Archive contains a corrupt tar header');
}

function parsePaxPath(data) {
  let offset = 0;
  let entryPath = null;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) fail('Archive contains malformed PAX metadata');
    const length = Number.parseInt(data.toString('ascii', offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length || data[offset + length - 1] !== 10) {
      fail('Archive contains malformed PAX metadata');
    }
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const separator = record.indexOf('=');
    if (separator < 1) fail('Archive contains malformed PAX metadata');
    const key = record.slice(0, separator);
    if (key !== 'path' || entryPath !== null) fail(`Archive contains unsupported PAX metadata: ${key}`);
    entryPath = record.slice(separator + 1);
    offset += length;
  }
  return entryPath;
}

function safeArchivePath(entryName) {
  if (!entryName.startsWith('package/') || entryName.includes('\\') || entryName.includes('\0')) {
    fail(`Archive entry has an unsafe path: ${entryName}`);
  }
  const relative = entryName.slice('package/'.length).replace(/\/$/, '');
  const parts = relative.split('/');
  if (!relative || parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`Archive entry has an unsafe path: ${entryName}`);
  }
  return parts.join(path.sep);
}

class StreamReader {
  constructor(stream, limit) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.done = false;
    this.total = 0;
    this.limit = limit;
  }

  async take(maximum) {
    while (this.offset >= this.chunk.length && !this.done) {
      const next = await this.iterator.next();
      this.done = next.done === true;
      this.chunk = this.done ? Buffer.alloc(0) : Buffer.from(next.value);
      this.offset = 0;
    }
    if (this.done) return null;
    const length = Math.min(maximum, this.chunk.length - this.offset);
    const result = this.chunk.subarray(this.offset, this.offset + length);
    this.offset += length;
    this.total += length;
    if (this.total > this.limit) fail('Archive exceeds the extraction limit');
    return result;
  }

  async readExact(length, allowEof = false) {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = await this.take(length - written);
      if (!chunk) {
        if (allowEof && written === 0) return null;
        fail('Archive ended before the current tar entry completed');
      }
      chunk.copy(result, written);
      written += chunk.length;
    }
    return result;
  }

  async writeTo(fileHandle, length) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.take(Math.min(remaining, 64 * 1024));
      if (!chunk) fail('Archive ended before the current tar entry completed');
      await fileHandle.write(chunk);
      remaining -= chunk.length;
    }
  }

  async skip(length) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.take(remaining);
      if (!chunk) fail('Archive ended before tar padding completed');
      remaining -= chunk.length;
    }
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDirectoryDurable(directory, mode = 0o755) {
  const missing = [];
  let current = path.resolve(directory);
  while (!(await fsp.stat(current).catch(() => null))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of missing.reverse()) {
    await fsp.mkdir(candidate, { mode }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await syncDirectory(path.dirname(candidate));
    await syncDirectory(candidate);
  }
}

async function syncTree(directory) {
  const directories = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    directories.push(current);
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        const handle = await fsp.open(entryPath, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
  }
  for (const current of directories.sort((left, right) => right.length - left.length)) await syncDirectory(current);
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function buildTreeManifest(directory) {
  const manifest = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    const current = path.join(directory, relative);
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      const entryPath = path.join(directory, entryRelative);
      const stat = await fsp.lstat(entryPath);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail(`Release tree contains unsupported entry ${entryRelative}`);
      if (entry.isDirectory()) {
        manifest.push({ path: entryRelative, type: 'directory', mode: stat.mode & 0o777 });
        pending.push(entryRelative);
      } else {
        manifest.push({ path: entryRelative, type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: await hashFile(entryPath) });
      }
    }
  }
  return manifest.sort((left, right) => left.path.localeCompare(right.path));
}

async function downloadArchive(fetchImpl, url, destination, expectedSize, expectedSha256) {
  const response = await fetchWithRedirects(fetchImpl, url, 'OpenChamber archive', { timeoutMs: ARCHIVE_DOWNLOAD_TIMEOUT_MS });
  if (!response.ok) fail(`OpenChamber archive request failed with ${response.status}`);
  const contentLength = response.headers.get('content-length');
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== expectedSize) fail('OpenChamber archive content length does not match the GitHub Release');
  if (!response.body) fail('OpenChamber archive response has no body');
  const handle = await fsp.open(destination, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let downloaded = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > expectedSize || downloaded > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        fail('OpenChamber archive exceeds its validated size');
      }
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (downloaded !== expectedSize) fail('Downloaded archive size does not match the GitHub Release');
    if (hash.digest('hex') !== expectedSha256) fail('Downloaded archive SHA-256 does not match the update channel');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fsp.rm(destination, { force: true });
    throw error;
  }
  await handle.close();
}

async function extractValidatedTgz(archivePath, destination) {
  const gunzip = fs.createReadStream(archivePath).pipe(createGunzip());
  const reader = new StreamReader(gunzip, MAX_EXTRACTED_BYTES);
  let totalSize = 0;
  let entryCount = 0;
  let nextPath = null;
  const seen = new Set();
  const directories = new Set([destination]);
  try {
    while (true) {
      const header = await reader.readExact(TAR_BLOCK_SIZE, true);
      if (!header) break;
      if (header.every((byte) => byte === 0)) {
        const secondEndBlock = await reader.readExact(TAR_BLOCK_SIZE);
        if (!secondEndBlock.every((byte) => byte === 0)) fail('Archive has data after its first end block');
        while (true) {
          const trailing = await reader.take(64 * 1024);
          if (!trailing) break;
          if (!trailing.every((byte) => byte === 0)) fail('Archive has nonzero trailing data');
        }
        break;
      }
      verifyTarHeader(header, 0);
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) fail('Archive contains too many entries');
      const name = parseTarString(header, 0, 100);
      const prefix = parseTarString(header, 345, 155);
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const size = parseTarNumber(header, 124, 12);
      const mode = parseTarNumber(header, 100, 8);
      const type = String.fromCharCode(header[156] || 48);
      const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;

      if (type === 'x') {
        if (size > MAX_TAR_METADATA_BYTES) fail('Archive PAX metadata exceeds the limit');
        const data = await reader.readExact(size);
        nextPath = parsePaxPath(data) || nextPath;
        await reader.skip(padding);
        continue;
      }
      if (type === 'L') {
        if (size > MAX_TAR_METADATA_BYTES) fail('Archive GNU path metadata exceeds the limit');
        const data = await reader.readExact(size);
        nextPath = data.toString('utf8').replace(/\0.*$/s, '').trimEnd();
        await reader.skip(padding);
        continue;
      }
      if (type !== '0' && type !== '5') fail(`Archive entry type ${type} is not allowed`);

      const entryPath = nextPath || headerPath;
      nextPath = null;
      if (type === '5' && (entryPath === 'package' || entryPath === 'package/')) {
        if (size !== 0) fail('Archive directory entry contains data');
        if (seen.has('')) fail('Archive contains a duplicate entry: package/');
        seen.add('');
        continue;
      }
      const relative = safeArchivePath(entryPath);
      if (seen.has(relative)) fail(`Archive contains a duplicate entry: ${entryPath}`);
      seen.add(relative);
      const outputPath = path.join(destination, relative);
      totalSize += size;
      if (totalSize > MAX_EXTRACTED_BYTES) fail('Archive exceeds the extraction limit');
      if (type === '5') {
        if (size !== 0) fail('Archive directory entry contains data');
        await ensureDirectoryDurable(outputPath);
        directories.add(outputPath);
        continue;
      }
      if (size > MAX_FILE_BYTES) fail(`Archive entry exceeds the per-file limit: ${entryPath}`);
      const parent = path.dirname(outputPath);
      await ensureDirectoryDurable(parent);
      directories.add(parent);
      const fileHandle = await fsp.open(outputPath, 'wx', (mode & 0o111) !== 0 ? 0o755 : 0o644);
      try {
        await reader.writeTo(fileHandle, size);
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await reader.skip(padding);
    }
    if (nextPath) fail('Archive ended with unused path metadata');
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory);
  } catch (error) {
    gunzip.destroy();
    throw error;
  } finally {
    gunzip.destroy();
  }
}

async function readJsonFile(filePath, label) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    fail(`${label} is missing or malformed`);
  }
}

async function readInstalledIdentity(directory) {
  const packageJson = await readJsonFile(path.join(directory, 'package.json'), 'Installed package.json');
  const buildRevision = await readJsonFile(path.join(directory, 'dist', 'build-revision.json'), 'Installed build revision');
  if (packageJson.name !== '@openchamber/web' || !isString(packageJson.version) || !BUILD_REVISION_PATTERN.test(buildRevision.revision)) {
    fail('Installed package identity is invalid');
  }
  return { version: packageJson.version, revision: buildRevision.revision };
}

async function validateExtractedRelease(directory, channel) {
  const packageJson = await readJsonFile(path.join(directory, 'package.json'), 'Extracted package.json');
  if (!isPlainObject(packageJson) || packageJson.name !== '@openchamber/web' || packageJson.version !== channel.version) {
    fail('Extracted package identity does not match the update channel');
  }
  if (!hasExactKeys(packageJson.openchamberArtifact, ['platform', 'arch', 'nodeAbi'])
    || packageJson.openchamberArtifact.platform !== channel.platform
    || packageJson.openchamberArtifact.arch !== channel.arch
    || packageJson.openchamberArtifact.nodeAbi !== channel.nodeAbi) {
    fail('Extracted package target metadata does not match the update channel');
  }
  const revision = await readJsonFile(path.join(directory, 'dist', 'build-revision.json'), 'Extracted build revision');
  if (!hasExactKeys(revision, ['revision']) || revision.revision !== channel.sourceCommit) {
    fail('Extracted build revision does not match the update channel');
  }
  const cli = path.join(directory, 'bin', 'cli.js');
  for (const required of [cli, path.join(directory, 'server', 'index.js'), path.join(directory, 'dist', 'index.html')]) {
    const stat = await fsp.stat(required).catch(() => null);
    if (!stat?.isFile()) fail(`Extracted OpenChamber release is missing ${path.relative(directory, required)}`);
  }
}

async function resolveBundledDependency(packageDirectory, dependency, releaseDirectory) {
  if (!PACKAGE_NAME_PATTERN.test(dependency)) fail(`Bundled dependency name is invalid: ${dependency}`);
  let current = packageDirectory;
  while (isPathInside(releaseDirectory, current)) {
    const candidate = path.join(current, 'node_modules', ...dependency.split('/'));
    const candidateStat = await fsp.lstat(candidate).catch(() => null);
    if (candidateStat) {
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) fail(`Bundled dependency ${dependency} is not a real directory`);
      return candidate;
    }
    if (current === releaseDirectory) break;
    current = path.dirname(current);
  }
  return null;
}

async function validateBundledDependencies(releaseDirectory, channelTarget) {
  const rootModules = await fsp.lstat(path.join(releaseDirectory, 'node_modules')).catch(() => null);
  if (!rootModules?.isDirectory() || rootModules.isSymbolicLink()) fail('Validated release does not bundle production node_modules');
  const canonicalReleaseDirectory = await fsp.realpath(releaseDirectory);
  const pending = [canonicalReleaseDirectory];
  const visited = new Set();
  while (pending.length > 0) {
    const packageDirectory = pending.pop();
    const canonical = await fsp.realpath(packageDirectory);
    if (!isPathInside(canonicalReleaseDirectory, canonical)) fail('Bundled dependency escapes the release directory');
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const packageJson = await readJsonFile(path.join(canonical, 'package.json'), 'Bundled dependency package.json');
    if (Array.isArray(packageJson.os) && (packageJson.os.includes(`!${channelTarget.platform}`) || (!packageJson.os.includes(channelTarget.platform) && !packageJson.os.every((value) => String(value).startsWith('!'))))) {
      fail(`Bundled dependency ${packageJson.name || canonical} does not support ${channelTarget.platform}`);
    }
    if (Array.isArray(packageJson.cpu) && (packageJson.cpu.includes(`!${channelTarget.arch}`) || (!packageJson.cpu.includes(channelTarget.arch) && !packageJson.cpu.every((value) => String(value).startsWith('!'))))) {
      fail(`Bundled dependency ${packageJson.name || canonical} does not support ${channelTarget.arch}`);
    }
    const dependencies = isPlainObject(packageJson.dependencies) ? Object.keys(packageJson.dependencies) : [];
    const optionalDependencies = isPlainObject(packageJson.optionalDependencies) ? Object.keys(packageJson.optionalDependencies) : [];
    const peerDependencies = isPlainObject(packageJson.peerDependencies) ? Object.keys(packageJson.peerDependencies) : [];
    const peerMetadata = isPlainObject(packageJson.peerDependenciesMeta) ? packageJson.peerDependenciesMeta : {};
    const requiredPeers = peerDependencies.filter((dependency) => !isPlainObject(peerMetadata[dependency]) || peerMetadata[dependency].optional !== true);
    const optionalPeers = peerDependencies.filter((dependency) => isPlainObject(peerMetadata[dependency]) && peerMetadata[dependency].optional === true);
    for (const dependency of new Set([...dependencies, ...requiredPeers])) {
      const resolved = await resolveBundledDependency(canonical, dependency, canonicalReleaseDirectory);
      if (!resolved) fail(`Validated release is missing bundled dependency ${dependency}`);
      pending.push(resolved);
    }
    for (const dependency of new Set([...optionalDependencies, ...optionalPeers])) {
      const resolved = await resolveBundledDependency(canonical, dependency, canonicalReleaseDirectory);
      if (resolved) pending.push(resolved);
    }
  }
}

async function resolveInstalledDependency(packageDirectory, dependency) {
  let current = packageDirectory;
  while (path.dirname(current) !== current) {
    const candidate = path.join(current, 'node_modules', ...dependency.split('/'));
    if (await fsp.stat(path.join(candidate, 'package.json')).catch(() => null)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

async function archiveInstalledPackage(sourceDirectory, destinationDirectory, active = new Set()) {
  const canonicalSource = await fsp.realpath(sourceDirectory);
  if (active.has(canonicalSource)) return;
  active.add(canonicalSource);
  await fsp.cp(canonicalSource, destinationDirectory, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    filter: (source) => {
      const relative = path.relative(canonicalSource, source);
      return relative === '' || (relative !== 'node_modules' && !relative.startsWith(`node_modules${path.sep}`));
    },
  });
  const packageJson = await readJsonFile(path.join(canonicalSource, 'package.json'), 'Installed package.json');
  const dependencies = isPlainObject(packageJson.dependencies) ? Object.keys(packageJson.dependencies) : [];
  const optionalDependencies = isPlainObject(packageJson.optionalDependencies) ? Object.keys(packageJson.optionalDependencies) : [];
  const peers = isPlainObject(packageJson.peerDependencies) ? Object.keys(packageJson.peerDependencies) : [];
  const peerMetadata = isPlainObject(packageJson.peerDependenciesMeta) ? packageJson.peerDependenciesMeta : {};
  const required = new Set([...dependencies, ...peers.filter((dependency) => !isPlainObject(peerMetadata[dependency]) || peerMetadata[dependency].optional !== true)]);
  const optional = new Set([...optionalDependencies, ...peers.filter((dependency) => isPlainObject(peerMetadata[dependency]) && peerMetadata[dependency].optional === true)]);
  for (const dependency of new Set([...required, ...optional])) {
    const dependencySource = await resolveInstalledDependency(canonicalSource, dependency);
    if (!dependencySource) {
      if (required.has(dependency)) fail(`Current install is missing dependency ${dependency} required for rollback archive`);
      continue;
    }
    const dependencyDestination = path.join(destinationDirectory, 'node_modules', ...dependency.split('/'));
    await ensureDirectoryDurable(path.dirname(dependencyDestination));
    await archiveInstalledPackage(dependencySource, dependencyDestination, new Set(active));
  }
}

async function replaceSymlink(linkPath, targetPath) {
  const temporary = `${linkPath}.next-${crypto.randomUUID()}`;
  await fsp.symlink(targetPath, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await fsp.rename(temporary, linkPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function getLinkTarget(linkPath) {
  let stat;
  try {
    stat = await fsp.lstat(linkPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) fail(`${linkPath} exists but is not a symbolic link`);
  const target = path.resolve(path.dirname(linkPath), await fsp.readlink(linkPath));
  return fsp.realpath(target).catch(() => null);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function statePayload(state, currentVersion, values = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    state,
    currentVersion,
    targetVersion: values.targetVersion || null,
    previousVersion: values.previousVersion || null,
    error: values.error || null,
    updatedAt: new Date().toISOString(),
  };
}

function parsePersistedState(raw) {
  if (!hasExactKeys(raw, ['schemaVersion', 'state', 'currentVersion', 'targetVersion', 'previousVersion', 'error', 'updatedAt'])) return null;
  if (raw.schemaVersion !== SCHEMA_VERSION || !INSTALL_STATES.has(raw.state) || !isString(raw.currentVersion) || !isString(raw.updatedAt)) return null;
  for (const key of ['targetVersion', 'previousVersion', 'error']) {
    if (raw[key] !== null && !isString(raw[key])) return null;
  }
  return raw;
}

function readSelectedVersion(currentLink, installRoot) {
  try {
    const target = fs.realpathSync(currentLink);
    if (!isPathInside(path.join(installRoot, 'releases'), target)) return null;
    const packageJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    const revision = JSON.parse(fs.readFileSync(path.join(target, 'dist', 'build-revision.json'), 'utf8')).revision;
    if (!isString(packageJson.version) || !COMMIT_PATTERN.test(revision)) return null;
    return path.basename(target) === `${packageJson.version}-${revision.slice(0, 12)}` ? packageJson.version : null;
  } catch {
    return null;
  }
}

function parseCompare(raw, upstreamCommit, sourceCommit) {
  if (!isPlainObject(raw) || (raw.status !== 'ahead' && raw.status !== 'identical') || !isPlainObject(raw.merge_base_commit)) {
    fail('GitHub upstream ancestry metadata is malformed or does not prove ancestry');
  }
  if (raw.merge_base_commit.sha !== upstreamCommit) fail('Validated source commit does not descend from the claimed upstream tag');
  if (raw.status === 'identical' && upstreamCommit !== sourceCommit) fail('GitHub upstream ancestry response is inconsistent');
}

export function createValidatedReleaseInstaller(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const installRoot = resolveManagedInstallRoot(options.installRoot || INSTALL_ROOT);
  const currentInstallDir = options.currentInstallDir || MODULE_PACKAGE_ROOT;
  const currentVersion = options.currentVersion || 'unknown';
  const repository = options.repository || REPOSITORY;
  const githubToken = options.githubToken || process.env.OPENCHAMBER_UPDATE_GITHUB_TOKEN || '';
  const target = {
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    nodeAbi: options.nodeAbi || process.versions.modules,
  };
  if (!REPOSITORY_PATTERN.test(repository)) fail('Update channel repository is invalid');
  if (githubToken && (!isString(githubToken) || githubToken.length > 1024 || /[\r\n]/.test(githubToken))) fail('Update channel GitHub token is invalid');
  const releaseApiUrl = options.releaseApiUrl || `https://api.github.com/repos/${repository}/releases/latest`;
  const statePath = path.join(installRoot, 'update-status.json');
  const lockPath = path.join(installRoot, 'update.lock');
  const transactionPath = path.join(installRoot, 'restart-transaction.json');
  const currentLink = path.join(installRoot, 'current');
  const previousLink = path.join(installRoot, 'previous');
  let activeInstall = null;
  let status = statePayload('installed', currentVersion);

  try {
    const persisted = parsePersistedState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    const selectedVersion = readSelectedVersion(currentLink, installRoot);
    const transactionPending = fs.existsSync(transactionPath);
    if (transactionPending && (persisted?.state === 'restarting' || ACTIVE_STATES.has(persisted?.state))) {
      status = statePayload('restarting', currentVersion, { targetVersion: persisted.targetVersion, previousVersion: persisted.previousVersion, error: persisted.error });
    } else if (persisted?.state === 'restarting' || (persisted && ACTIVE_STATES.has(persisted.state))) {
      status = statePayload('failed', currentVersion, {
        targetVersion: persisted.targetVersion,
        previousVersion: persisted.previousVersion,
        error: selectedVersion === persisted.targetVersion
          ? 'OpenChamber update restart transaction is missing'
          : 'OpenChamber update was interrupted before completion',
      });
    } else if (persisted && persisted.state !== 'restarting' && !ACTIVE_STATES.has(persisted.state)) {
      status = persisted;
    }
  } catch {
  }

  async function persist(next) {
    status = next;
    options.onStateChange?.(next);
    await ensureDirectoryDurable(installRoot);
    const temporary = `${statePath}.tmp-${crypto.randomUUID()}`;
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, statePath);
    await syncDirectory(installRoot);
  }

  function syncStatusFromDisk() {
    if (activeInstall) return status;
    try {
      const persisted = parsePersistedState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
      if (persisted && persisted.updatedAt !== status.updatedAt) {
        if (persisted.state === 'restarting' || ACTIVE_STATES.has(persisted.state)) {
          status = fs.existsSync(transactionPath)
            ? { ...persisted, state: 'restarting', currentVersion }
            : { ...persisted, state: 'failed', currentVersion, error: 'OpenChamber update restart transaction is missing' };
        } else {
          status = persisted;
        }
        options.onStateChange?.(status);
      }
    } catch {}
    return status;
  }

  async function acquireLock() {
    await ensureDirectoryDurable(installRoot);
    try {
      return await properLockfile.lock(installRoot, {
        realpath: false,
        lockfilePath: lockPath,
        stale: LOCK_STALE_MS,
        update: 10_000,
        retries: 0,
      });
    } catch (error) {
      if (error?.code === 'ELOCKED') fail('Another OpenChamber update owns the installation lock');
      throw error;
    }
  }

  async function releaseLock(release) {
    await release();
    await syncDirectory(installRoot);
  }

  function noteAvailable(updateInfo) {
    if (activeInstall || !updateInfo?.available || !isString(updateInfo.version)) return;
    status = statePayload('available', currentVersion, { targetVersion: updateInfo.version });
  }

  async function resolveChannel() {
    const release = parseRelease(await fetchJson(fetchImpl, releaseApiUrl, 'GitHub release metadata', { noReleaseOn404: true, githubToken }));
    const commitUrl = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(release.tag)}`;
    const tagCommit = parseTagCommit(await fetchJson(fetchImpl, commitUrl, 'GitHub tag commit metadata', { githubToken }));
    const channelAsset = getUniqueAsset(release, 'channel.json');
    validateAssetUrl(channelAsset, release.tag, repository);
    const channel = validateChannelMetadata(
      await fetchJson(fetchImpl, channelAsset.url, 'Update channel metadata', { githubToken }),
      release,
      tagCommit,
      target,
    );
    const upstreamTagUrl = `https://api.github.com/repos/openchamber/openchamber/commits/${encodeURIComponent(channel.upstreamTag || `v${channel.baseVersion}`)}`;
    const upstreamCommit = parseTagCommit(await fetchJson(fetchImpl, upstreamTagUrl, 'GitHub upstream tag metadata', { githubToken }));
    // GitHub includes changed-file patches only on page 1; later pages retain the ancestry fields.
    const compareUrl = `https://api.github.com/repos/${repository}/compare/${upstreamCommit}...${channel.sourceCommit}?per_page=1&page=2`;
    parseCompare(await fetchJson(fetchImpl, compareUrl, 'GitHub upstream ancestry metadata', { githubToken }), upstreamCommit, channel.sourceCommit);
    const releaseAssetNames = release.assets.map((asset) => asset.name).sort();
    if (JSON.stringify(releaseAssetNames) !== JSON.stringify([...channel.assets].sort())) {
      fail('GitHub Release asset inventory does not match the update channel');
    }
    const archiveAsset = getUniqueAsset(release, channel.archive.name);
    const checksumAsset = getUniqueAsset(release, channel.archive.checksumName);
    validateAssetUrl(archiveAsset, release.tag, repository);
    validateAssetUrl(checksumAsset, release.tag, repository);
    if (archiveAsset.size > MAX_DOWNLOAD_BYTES) fail('GitHub archive exceeds the download limit');
    return { channel, archiveAsset, checksumAsset };
  }

  function compareChannelVersions(left, right) {
    const parse = (value) => {
      const channelMatch = String(value).match(CHANNEL_VERSION_PATTERN);
      const baseMatch = String(value).match(BASE_VERSION_PATTERN);
      const match = channelMatch || baseMatch;
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), channelMatch ? Number(channelMatch[4]) : 0];
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return null;
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }

  async function checkForUpdate() {
    let channel;
    try {
      ({ channel } = await resolveChannel());
    } catch (error) {
      if (!(error instanceof NoValidatedReleaseError)) throw error;
      await persist(statePayload('no-validated-release', currentVersion));
      return { available: false, currentVersion, version: null, channel: CHANNEL_ID, channelRepository: repository, noValidatedRelease: true };
    }
    const comparison = compareChannelVersions(channel.version, currentVersion);
    if (comparison !== null && comparison < 0) {
      await persist(statePayload('no-validated-release', currentVersion));
      return { available: false, currentVersion, version: channel.version, channel: CHANNEL_ID, channelRepository: repository, noValidatedRelease: true, reason: 'channel-base-older' };
    }
    const available = comparison === null || comparison > 0;
    const result = {
      available,
      version: channel.version,
      currentVersion,
      releaseUrl: `https://github.com/${repository}/releases/tag/${channel.releaseTag}`,
      packageManager: 'validated-channel',
      updateCommand: 'openchamber update',
      channel: CHANNEL_ID,
      channelRepository: repository,
    };
    if (comparison === 0 && status.state === 'no-validated-release') {
      await persist(statePayload('installed', currentVersion, { targetVersion: currentVersion }));
    } else {
      noteAvailable(result);
    }
    return result;
  }

  async function beginInstall({ targetVersion, prepareRestart = async () => null, handoffRestart, cancelRestart = async () => {} }) {
    if (activeInstall || status.state === 'restarting' || ACTIVE_STATES.has(status.state)) fail('An OpenChamber update is already in progress');
    let admittedLock;
    try {
      admittedLock = await acquireLock();
      if (await fsp.lstat(transactionPath).then(() => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error))) {
        fail('An OpenChamber restart transaction is still pending');
      }
      await persist(statePayload('downloading', currentVersion, { targetVersion }));
    } catch (error) {
      if (admittedLock) await releaseLock(admittedLock);
      throw error;
    }
    activeInstall = (async () => {
      const lock = admittedLock;
      let stagingDirectory = null;
      let archivePath = null;
      let previousTarget = null;
      let switched = false;
      let restartPrepared = false;
      let restartPreparation = null;
      let channel = null;
      try {
        const canonicalInstallRoot = await fsp.realpath(installRoot);
        const resolved = await resolveChannel();
        channel = resolved.channel;
        if (channel.version !== targetVersion) fail('Validated release version does not match the requested update');
        const { archiveAsset, checksumAsset } = resolved;
        const checksumBytes = await fetchBytes(fetchImpl, checksumAsset.url, 4096, 'Checksum asset', { githubToken });
        const declaredChecksum = parseChecksumFile(checksumBytes, channel.archive.name);
        if (declaredChecksum !== channel.archive.sha256) fail('Checksum asset does not match the update channel');
        await persist(statePayload('installing', currentVersion, { targetVersion: channel.version }));
        stagingDirectory = path.join(canonicalInstallRoot, 'staging', crypto.randomUUID());
        await ensureDirectoryDurable(stagingDirectory);
        archivePath = path.join(stagingDirectory, '.archive.tgz');
        await downloadArchive(fetchImpl, archiveAsset.url, archivePath, archiveAsset.size, channel.archive.sha256);
        await extractValidatedTgz(archivePath, stagingDirectory);
        await fsp.rm(archivePath);
        archivePath = null;
        await validateExtractedRelease(stagingDirectory, channel);
        await validateBundledDependencies(stagingDirectory, channel);
        await syncDirectory(stagingDirectory);

        const releaseDirectory = path.join(canonicalInstallRoot, 'releases', `${channel.version}-${channel.sourceCommit.slice(0, 12)}`);
        await ensureDirectoryDurable(path.dirname(releaseDirectory));
        const releaseExists = await fsp.lstat(releaseDirectory).catch(() => null);
        if (releaseExists) {
          if (!releaseExists.isDirectory() || releaseExists.isSymbolicLink()) fail('Validated release path exists with an unsafe type');
          await validateExtractedRelease(releaseDirectory, channel);
          await validateBundledDependencies(releaseDirectory, channel);
          const [stagingManifest, existingManifest] = await Promise.all([
            buildTreeManifest(stagingDirectory),
            buildTreeManifest(releaseDirectory),
          ]);
          if (JSON.stringify(stagingManifest) !== JSON.stringify(existingManifest)) {
            fail('Existing validated release directory differs from the checksum-verified artifact');
          }
          await fsp.rm(stagingDirectory, { recursive: true });
          stagingDirectory = null;
        } else {
          await fsp.rename(stagingDirectory, releaseDirectory);
          stagingDirectory = null;
          await syncDirectory(path.dirname(releaseDirectory));
        }

        previousTarget = await getLinkTarget(currentLink);
        let previousVersion = currentVersion;
        if (previousTarget) {
          const previousStat = await fsp.stat(previousTarget).catch(() => null);
          if (!previousStat?.isDirectory()) previousTarget = null;
        }
        if (!previousTarget || !isPathInside(canonicalInstallRoot, previousTarget)) {
          const archiveSource = previousTarget || currentInstallDir;
          const archiveDirectory = path.join(canonicalInstallRoot, 'archives', `${currentVersion}-${Date.now()}`);
          await ensureDirectoryDurable(path.dirname(archiveDirectory));
          await archiveInstalledPackage(archiveSource, archiveDirectory);
          await syncTree(archiveDirectory);
          await syncDirectory(path.dirname(archiveDirectory));
          previousTarget = archiveDirectory;
        }
        const previousIdentity = await readInstalledIdentity(previousTarget);
        if (previousIdentity.version !== currentVersion) fail('Rollback archive version does not match the running version');
        const restartContext = {
          installRoot: canonicalInstallRoot,
          statusPath: path.join(canonicalInstallRoot, 'update-status.json'),
          targetVersion,
          targetRevision: channel.sourceCommit,
          targetDirectory: releaseDirectory,
          previousVersion: currentVersion,
          previousRevision: previousIdentity.revision,
          previousDirectory: previousTarget,
        };
        options.faultInjector?.('before-restart-journal');
        restartPreparation = await prepareRestart(restartContext);
        restartPrepared = true;
        options.faultInjector?.('after-restart-journal');
        await replaceSymlink(previousLink, previousTarget);
        await replaceSymlink(currentLink, releaseDirectory);
        await syncDirectory(installRoot);
        switched = true;
        await persist(statePayload('restarting', currentVersion, { targetVersion: channel.version, previousVersion }));
        options.faultInjector?.('after-release-selection');
        await handoffRestart({ ...restartContext, restartPreparation });
        return status;
      } catch (error) {
        if (error?.code === 'SIMULATED_PROCESS_CRASH') throw error;
        const message = error instanceof Error ? error.message : 'OpenChamber update failed';
        try {
          if (switched && previousTarget) {
            await replaceSymlink(currentLink, previousTarget);
          }
          if (restartPrepared) await cancelRestart({ restartPreparation, error });
          if (switched && previousTarget) {
            await persist(statePayload('rollback', currentVersion, { targetVersion: channel?.version || targetVersion, previousVersion: currentVersion, error: message }));
          } else {
            await persist(statePayload('failed', currentVersion, { targetVersion, error: message }));
          }
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : 'rollback failed';
          await persist(statePayload('failed', currentVersion, { targetVersion: channel?.version || targetVersion, error: `${message}; rollback failed: ${rollbackMessage}` }));
        }
        throw error;
      } finally {
        if (archivePath) await fsp.rm(archivePath, { force: true }).catch(() => {});
        if (stagingDirectory) await fsp.rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
        if (lock) await releaseLock(lock);
        activeInstall = null;
      }
    })();
    return { completion: activeInstall };
  }

  async function install(args) {
    const { completion } = await beginInstall(args);
    return completion;
  }

  return {
    getStatus: syncStatusFromDisk,
    isInstalling: () => {
      const currentStatus = syncStatusFromDisk();
      return activeInstall !== null || currentStatus.state === 'restarting' || ACTIVE_STATES.has(currentStatus.state);
    },
    noteAvailable,
    checkForUpdate,
    beginInstall,
    install,
  };
}
