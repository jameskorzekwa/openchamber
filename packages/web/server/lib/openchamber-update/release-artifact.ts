import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import type { FileHandle } from 'node:fs/promises';
import type { JsonValue } from '../shared/json-values.js';
import { fail, hasErrorCode, hasExactKeys, isPlainObject, isString } from './release-contract.js';
import type { Target, Channel } from './release-contract.js';

interface FetchOptions { timeoutMs?: number; githubToken?: string; noReleaseOn404?: boolean }
type GitHubRequestHeaders = {
  Accept: string;
  'User-Agent': string;
  Authorization?: string;
};

const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_TAR_METADATA_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const TAR_BLOCK_SIZE = 512;

export class NoValidatedReleaseError extends Error {
  constructor() {
    super('No validated OpenChamber release is available');
    this.name = 'NoValidatedReleaseError';
  }
}

async function readResponseBytes(response: Response, limit: number, label: string) {
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

function validateFetchUrl(value: string | URL, mode: string, initialUrl: URL) {
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

async function fetchWithRedirects(fetchImpl: typeof fetch, value: string, label: string, options: FetchOptions = {}) {
  const initialUrl = new URL(value);
  const mode = initialUrl.hostname === 'api.github.com' ? 'api' : 'asset';
  const signal = AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS);
  let url = validateFetchUrl(initialUrl, mode, initialUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers: GitHubRequestHeaders = {
      Accept: mode === 'api' ? 'application/vnd.github+json' : 'application/octet-stream',
      'User-Agent': 'openchamber-validated-updater',
    };
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

export async function fetchBytes(fetchImpl: typeof fetch, url: string, limit: number, label: string, options: FetchOptions = {}) {
  const response = await fetchWithRedirects(fetchImpl, url, label, options);
  if (options.noReleaseOn404 && response.status === 404) throw new NoValidatedReleaseError();
  if (!response.ok) fail(`${label} request failed with ${response.status}`);
  return readResponseBytes(response, limit, label);
}

export async function fetchJson(fetchImpl: typeof fetch, url: string, label: string, options: FetchOptions): Promise<JsonValue> {
  const bytes = await fetchBytes(fetchImpl, url, 1024 * 1024, label, options);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function parseChecksumFile(bytes: Buffer, artifacts: { tarball: string; sha256: string }[]) {
  const lines = bytes.toString('utf8').match(/^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/gm) || [];
  const expectedLines = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.tarball}`);
  if (lines.length !== artifacts.length || bytes.toString('utf8') !== `${expectedLines.join('\n')}\n`) {
    fail('Checksum asset does not match every channel artifact or is malformed');
  }
}

function parseTarString(buffer: Buffer, start: number, length: number) {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}

function parseTarNumber(buffer: Buffer, start: number, length: number) {
  if (((buffer[start] ?? 0) & 0x80) !== 0) fail('Base-256 tar numbers are not supported');
  const raw = parseTarString(buffer, start, length).trim();
  if (!/^[0-7]*$/.test(raw)) fail('Archive contains an invalid tar number');
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('Archive contains an invalid tar number');
  return value;
}

function verifyTarHeader(buffer: Buffer, offset: number) {
  const stored = parseTarNumber(buffer, offset + 148, 8);
  let calculated = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    calculated += index >= 148 && index < 156 ? 32 : (buffer[offset + index] ?? NaN);
  }
  if (stored !== calculated) fail('Archive contains a corrupt tar header');
}

function parsePaxPath(data: Buffer) {
  let offset = 0;
  let entryPath: string | null = null;
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

function safeArchivePath(entryName: string) {
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
  iterator: AsyncIterator<Uint8Array>;
  chunk: Buffer;
  offset: number;
  done: boolean;
  total: number;
  limit: number;
  constructor(stream: AsyncIterable<Uint8Array>, limit: number) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunk = Buffer.alloc(0);
    this.offset = 0;
    this.done = false;
    this.total = 0;
    this.limit = limit;
  }

  async take(maximum: number) {
    while (this.offset >= this.chunk.length && !this.done) {
      const next = await this.iterator.next();
      this.done = next.done === true;
      this.chunk = next.done ? Buffer.alloc(0) : Buffer.from(next.value);
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

  readExact(length: number, allowEof?: false): Promise<Buffer>;
  readExact(length: number, allowEof: true): Promise<Buffer | null>;
  async readExact(length: number, allowEof = false): Promise<Buffer | null> {
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

  async writeTo(fileHandle: FileHandle, length: number) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.take(Math.min(remaining, 64 * 1024));
      if (!chunk) fail('Archive ended before the current tar entry completed');
      await fileHandle.write(chunk);
      remaining -= chunk.length;
    }
  }

  async skip(length: number) {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.take(remaining);
      if (!chunk) fail('Archive ended before tar padding completed');
      remaining -= chunk.length;
    }
  }
}

export async function syncDirectory(directory: string) {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureDirectoryDurable(directory: string, mode = 0o755) {
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

export async function syncTree(directory: string) {
  const directories = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
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

async function hashFile(filePath: string) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function buildTreeManifest(directory: string) {
  const manifest = [];
  const pending = [''];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (relative === undefined) break;
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

export async function downloadArchive(fetchImpl: typeof fetch, url: string, destination: string, expectedSize: number, expectedSha256: string) {
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

export async function extractValidatedTgz(archivePath: string, destination: string) {
  const gunzip = fs.createReadStream(archivePath).pipe(createGunzip());
  const reader = new StreamReader(gunzip, MAX_EXTRACTED_BYTES);
  let totalSize = 0;
  let entryCount = 0;
  let nextPath: string | null = null;
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

async function readJsonFile(filePath: string, label: string): Promise<JsonValue> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    fail(`${label} is missing or malformed`);
  }
}

export async function readInstalledIdentity(directory: string) {
  const packageJson = await readJsonFile(path.join(directory, 'package.json'), 'Installed package.json');
  const buildRevision = await readJsonFile(path.join(directory, 'dist', 'build-revision.json'), 'Installed build revision');
  if (!isPlainObject(packageJson) || !isPlainObject(buildRevision) || packageJson.name !== '@openchamber/web' || !isString(packageJson.version) || !isString(buildRevision.revision) || !BUILD_REVISION_PATTERN.test(buildRevision.revision)) {
    fail('Installed package identity is invalid');
  }
  return { version: packageJson.version, revision: buildRevision.revision };
}

export async function validateExtractedRelease(directory: string, channel: Channel) {
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
  const cli = path.join(directory, 'build', 'bin', 'cli.js');
  for (const required of [cli, path.join(directory, 'bin', 'cli.js'), path.join(directory, 'build', 'server', 'index.js'), path.join(directory, 'dist', 'index.html')]) {
    const stat = await fsp.stat(required).catch(() => null);
    if (!stat?.isFile()) fail(`Extracted OpenChamber release is missing ${path.relative(directory, required)}`);
  }
}

async function resolveBundledDependency(packageDirectory: string, dependency: string, releaseDirectory: string) {
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

export async function validateBundledDependencies(releaseDirectory: string, channelTarget: Target) {
  const rootModules = await fsp.lstat(path.join(releaseDirectory, 'node_modules')).catch(() => null);
  if (!rootModules?.isDirectory() || rootModules.isSymbolicLink()) fail('Validated release does not bundle production node_modules');
  const canonicalReleaseDirectory = await fsp.realpath(releaseDirectory);
  const pending = [canonicalReleaseDirectory];
  const visited = new Set();
  while (pending.length > 0) {
    const packageDirectory = pending.pop();
    if (packageDirectory === undefined) break;
    const canonical = await fsp.realpath(packageDirectory);
    if (!isPathInside(canonicalReleaseDirectory, canonical)) fail('Bundled dependency escapes the release directory');
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const packageJson = await readJsonFile(path.join(canonical, 'package.json'), 'Bundled dependency package.json');
    if (!isPlainObject(packageJson)) fail('Bundled dependency package.json is malformed');
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

async function resolveInstalledDependency(packageDirectory: string, dependency: string): Promise<string | null> {
  let current = packageDirectory;
  while (path.dirname(current) !== current) {
    const candidate = path.join(current, 'node_modules', ...dependency.split('/'));
    if (await fsp.stat(path.join(candidate, 'package.json')).catch(() => null)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

export async function archiveInstalledPackage(sourceDirectory: string, destinationDirectory: string, active = new Set<string>()): Promise<void> {
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
  if (!isPlainObject(packageJson)) fail('Installed package.json is malformed');
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

export async function replaceSymlink(linkPath: string, targetPath: string) {
  const temporary = `${linkPath}.next-${crypto.randomUUID()}`;
  await fsp.symlink(targetPath, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await fsp.rename(temporary, linkPath);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

export async function getLinkTarget(linkPath: string) {
  let stat;
  try {
    stat = await fsp.lstat(linkPath);
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) fail(`${linkPath} exists but is not a symbolic link`);
  const target = path.resolve(path.dirname(linkPath), await fsp.readlink(linkPath));
  return fsp.realpath(target).catch(() => null);
}

export function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
