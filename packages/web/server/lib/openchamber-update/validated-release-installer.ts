import { fail, hasErrorCode, hasExactKeys, isPlainObject, isString } from './release-contract.js';
import type { Target, Channel, Release, ReleaseAsset, Artifact } from './release-contract.js';
import { NoValidatedReleaseError, MAX_DOWNLOAD_BYTES, fetchBytes, fetchJson, parseChecksumFile, syncDirectory, ensureDirectoryDurable, syncTree, buildTreeManifest, downloadArchive, extractValidatedTgz, readInstalledIdentity, validateExtractedRelease, validateBundledDependencies, archiveInstalledPackage, replaceSymlink, getLinkTarget, isPathInside } from './release-artifact.js';
export { ensureDirectoryDurable } from './release-artifact.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import properLockfile from 'proper-lockfile';
import type { RestartContext } from './restart-transaction.js';
import { webPackagePaths } from '../web-package-paths.js';
import type { JsonValue } from '../shared/json-values.js';

export interface InstallationState {
  schemaVersion: number;
  state: string;
  currentVersion: string;
  targetVersion: string | null;
  previousVersion: string | null;
  error: string | null;
  updatedAt: string;
}
interface StateValues { targetVersion?: string | null; previousVersion?: string | null; error?: string | null }
export interface InstallerOptions {
  fetchImpl?: typeof fetch;
  installRoot?: string;
  currentInstallDir?: string;
  currentVersion?: string;
  repository?: string | undefined;
  githubToken?: string;
  platform?: string;
  arch?: string;
  nodeAbi?: string;
  releaseApiUrl?: string;
  companionReleaseApiUrl?: string;
  onStateChange?: (state: InstallationState) => void;
  faultInjector?: (point: string) => void;
}
export interface InstallArguments<Preparation> {
  targetVersion: string;
  prepareRestart?: (context: RestartContext) => Promise<Preparation | null>;
  handoffRestart: (context: RestartContext & { restartPreparation: Preparation | null }) => Promise<void>;
  cancelRestart?: (context: { restartPreparation: Preparation | null; error: unknown }) => Promise<void>;
}
const STATE_SCHEMA_VERSION = 1;
const LEGACY_CHANNEL_SCHEMA_VERSION = 1;
const MULTI_TARGET_CHANNEL_SCHEMA_VERSION = 2;
const CHANNEL_ID = 'j2k';
const REPOSITORY = 'jameskorzekwa/openchamber';
const INSTALL_ROOT = path.join(os.homedir(), '.local', 'share', 'openchamber');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANNEL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-j2k\.([1-9]\d*)$/;
const LEGACY_TARGET = Object.freeze({ platform: 'darwin', arch: 'arm64', nodeAbi: '137' });
const MULTI_TARGETS = Object.freeze([
  LEGACY_TARGET,
  Object.freeze({ platform: 'linux', arch: 'x64', nodeAbi: '137' }),
]);
const LOCK_STALE_MS = 30 * 60 * 1000;
const MODULE_PACKAGE_ROOT = webPackagePaths.root;
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

class ChannelBaseOlderError extends Error {
  version: string;
  constructor(version: string) {
    super(`Update channel ${version} is older than the running release and targets another runtime`);
    this.name = 'ChannelBaseOlderError';
    this.version = version;
  }
}

function compareChannelVersions(left: string, right: string) {
  const parse = (value: string): [number, number, number, number] | null => {
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
    const leftPart = a[index];
    const rightPart = b[index];
    if (leftPart !== undefined && rightPart !== undefined && leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

export function resolveManagedInstallRoot(input = INSTALL_ROOT): string {
  const absolute = path.resolve(input);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (!hasErrorCode(error) || error.code !== 'ENOENT' || path.dirname(absolute) === absolute) throw error;
    return path.join(resolveManagedInstallRoot(path.dirname(absolute)), path.basename(absolute));
  }
}

const isNumber = (value: unknown): value is number => typeof value === 'number';

function parseRelease(raw: JsonValue): Release {
  if (!isPlainObject(raw) || !isString(raw.tag_name) || !isString(raw.target_commitish) || !Array.isArray(raw.assets)) {
    fail('GitHub release metadata is malformed');
  }
  const assets = raw.assets.map((asset) => {
    if (!isPlainObject(asset) || !isString(asset.name) || !isString(asset.browser_download_url) || !isNumber(asset.size) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      fail('GitHub release asset metadata is malformed');
    }
    return { name: asset.name, url: asset.browser_download_url, size: asset.size };
  });
  return { tag: raw.tag_name, targetCommitish: raw.target_commitish, assets };
}

function parseTagCommit(raw: JsonValue) {
  if (!isPlainObject(raw) || !isString(raw.sha) || !COMMIT_PATTERN.test(raw.sha)) {
    fail('GitHub tag commit metadata is malformed');
  }
  return raw.sha;
}

export function validateChannelMetadata(raw: JsonValue, release: Release, tagCommit: string, target: Target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules }, currentVersion: string | null = null): Channel {
  const keys = [
    'schema', 'baseVersion', 'channelRevision', 'version', 'releaseTag', 'tarball',
    'checksumAsset', 'manifestAsset', 'assets', 'sha256', 'upstreamTag',
    'seriesHead', 'sourceCommit', 'minNode', 'platform', 'arch', 'nodeAbi',
  ];
  if (!hasExactKeys(raw, keys)) {
    fail('Update channel metadata has an invalid schema');
  }
  if (raw.schema !== LEGACY_CHANNEL_SCHEMA_VERSION) fail('Unsupported update channel schema');
  if (!isString(raw.baseVersion) || !BASE_VERSION_PATTERN.test(raw.baseVersion)) fail('Update channel base version is invalid');
  if (!isNumber(raw.channelRevision) || !Number.isSafeInteger(raw.channelRevision) || raw.channelRevision < 1) fail('Update channel revision is invalid');
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
    const comparison = currentVersion ? compareChannelVersions(raw.version, currentVersion) : null;
    if (comparison !== null && comparison < 0) throw new ChannelBaseOlderError(raw.version);
    fail(`Update channel target ${raw.platform}/${raw.arch}/ABI-${raw.nodeAbi} does not match ${target.platform}/${target.arch}/ABI-${target.nodeAbi}`);
  }
  return {
    schema: LEGACY_CHANNEL_SCHEMA_VERSION,
    channel: CHANNEL_ID,
    repository: REPOSITORY,
    baseVersion: raw.baseVersion,
    channelRevision: raw.channelRevision,
    releaseTag: raw.releaseTag,
    version: raw.version,
    upstreamTag: raw.upstreamTag,
    seriesHead: raw.seriesHead,
    sourceCommit: raw.sourceCommit,
    minNode: raw.minNode,
    platform: target.platform,
    arch: target.arch,
    nodeAbi: target.nodeAbi,
    assets: [expectedArchiveName, 'SHA256SUMS', 'channel.json'],
    archive: {
      name: raw.tarball,
      checksumName: raw.checksumAsset,
      sha256: raw.sha256,
    },
  };
}

function targetEquals(left: Target, right: Target) {
  return left.platform === right.platform && left.arch === right.arch && left.nodeAbi === right.nodeAbi;
}

function targetArchiveName(version: string, target: Target) {
  return `openchamber-web-${version}-${target.platform}-${target.arch}-abi${target.nodeAbi}.tgz`;
}

function validateMultiTargetChannelMetadata(raw: JsonValue, release: Release, tagCommit: string, stableChannel: Channel, target: Target): Channel & { artifacts: Artifact[] } {
  const keys = [
    'schema', 'baseVersion', 'channelRevision', 'version', 'releaseTag',
    'checksumAsset', 'manifestAsset', 'assets', 'artifacts', 'upstreamTag',
    'seriesHead', 'sourceCommit', 'minNode',
  ];
  if (!hasExactKeys(raw, keys)) fail('Multi-target update channel metadata has an invalid schema');
  if (raw.schema !== MULTI_TARGET_CHANNEL_SCHEMA_VERSION) fail('Unsupported multi-target update channel schema');
  const companionTag = `web-${stableChannel.releaseTag}`;
  if (raw.releaseTag !== companionTag || release.tag !== companionTag) {
    fail('Multi-target update channel release tag does not match the GitHub release');
  }
  for (const key of ['baseVersion', 'channelRevision', 'version', 'upstreamTag', 'seriesHead', 'sourceCommit'] as const) {
    if (raw[key] !== stableChannel[key]) fail(`Multi-target update channel ${key} does not match the stable channel`);
  }
  if (raw.minNode !== '22' || raw.minNode !== stableChannel.minNode) fail('Multi-target update channel minimum Node version is unsupported');
  if (raw.sourceCommit !== tagCommit) fail('Multi-target update channel source commit does not match the GitHub tag');
  if (COMMIT_PATTERN.test(release.targetCommitish) && release.targetCommitish !== raw.sourceCommit) {
    fail('GitHub companion release target commit does not match the update channel');
  }
  if (raw.checksumAsset !== 'SHA256SUMS' || raw.manifestAsset !== 'channel.json') {
    fail('Multi-target update channel asset names are invalid');
  }
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== MULTI_TARGETS.length) {
    fail('Multi-target update channel artifact inventory is invalid');
  }
  const artifacts = raw.artifacts.map((artifact, index) => {
    if (!hasExactKeys(artifact, ['platform', 'arch', 'nodeAbi', 'tarball', 'sha256'])) {
      fail('Multi-target update channel artifact metadata is invalid');
    }
    const expectedTarget = MULTI_TARGETS[index];
    if (!expectedTarget || artifact.platform !== expectedTarget.platform || artifact.arch !== expectedTarget.arch || artifact.nodeAbi !== expectedTarget.nodeAbi) fail('Multi-target update channel artifacts are missing, duplicated, or out of order');
    const expectedTarball = targetArchiveName(stableChannel.version, expectedTarget);
    if (artifact.tarball !== expectedTarball) fail('Multi-target update channel archive name does not match its target');
    if (!isString(artifact.sha256) || !SHA256_PATTERN.test(artifact.sha256)) fail('Multi-target update channel SHA-256 is invalid');
    return {
      platform: expectedTarget.platform,
      arch: expectedTarget.arch,
      nodeAbi: expectedTarget.nodeAbi,
      tarball: artifact.tarball,
      sha256: artifact.sha256,
    };
  });
  const expectedAssets = [...artifacts.map((artifact) => artifact.tarball), 'SHA256SUMS', 'channel.json'];
  if (!Array.isArray(raw.assets) || JSON.stringify(raw.assets) !== JSON.stringify(expectedAssets)) {
    fail('Multi-target update channel asset inventory is invalid');
  }
  const matches = artifacts.filter((artifact) => targetEquals(artifact, target));
  const match = matches[0];
  if (matches.length !== 1 || !match) {
    fail(`No unique validated OpenChamber artifact matches ${target.platform}/${target.arch}/ABI-${target.nodeAbi}`);
  }
  return {
    schema: MULTI_TARGET_CHANNEL_SCHEMA_VERSION,
    channel: CHANNEL_ID,
    repository: REPOSITORY,
    baseVersion: stableChannel.baseVersion,
    channelRevision: stableChannel.channelRevision,
    releaseTag: companionTag,
    version: stableChannel.version,
    upstreamTag: stableChannel.upstreamTag,
    seriesHead: stableChannel.seriesHead,
    sourceCommit: stableChannel.sourceCommit,
    minNode: raw.minNode,
    platform: match.platform,
    arch: match.arch,
    nodeAbi: match.nodeAbi,
    assets: expectedAssets,
    artifacts,
    archive: {
      name: match.tarball,
      checksumName: raw.checksumAsset,
      sha256: match.sha256,
    },
  };
}

function getUniqueAsset(release: Release, name: string) {
  const matches = release.assets.filter((asset) => asset.name === name);
  const match = matches[0];
  if (matches.length !== 1 || !match) fail(`Expected exactly one ${name} GitHub Release asset`);
  return match;
}

function validateAssetUrl(asset: ReleaseAsset, releaseTag: string, repository = REPOSITORY) {
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

function statePayload(state: string, currentVersion: string, values: StateValues = {}): InstallationState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    state,
    currentVersion,
    targetVersion: values.targetVersion || null,
    previousVersion: values.previousVersion || null,
    error: values.error || null,
    updatedAt: new Date().toISOString(),
  };
}

function parsePersistedState(raw: JsonValue): InstallationState | null {
  if (!hasExactKeys(raw, ['schemaVersion', 'state', 'currentVersion', 'targetVersion', 'previousVersion', 'error', 'updatedAt'])) return null;
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION || !isString(raw.state) || !INSTALL_STATES.has(raw.state) || !isString(raw.currentVersion) || !isString(raw.updatedAt)) return null;
  for (const key of ['targetVersion', 'previousVersion', 'error']) {
    if (raw[key] !== null && !isString(raw[key])) return null;
  }
  const { targetVersion, previousVersion, error } = raw;
  if ((targetVersion !== null && !isString(targetVersion)) || (previousVersion !== null && !isString(previousVersion)) || (error !== null && !isString(error))) return null;
  return { schemaVersion: raw.schemaVersion, state: raw.state, currentVersion: raw.currentVersion, updatedAt: raw.updatedAt, targetVersion, previousVersion, error };
}

function readSelectedVersion(currentLink: string, installRoot: string): string | null {
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

function parseCompare(raw: JsonValue, upstreamCommit: string, sourceCommit: string) {
  if (!isPlainObject(raw) || (raw.status !== 'ahead' && raw.status !== 'identical') || !isPlainObject(raw.merge_base_commit)) {
    fail('GitHub upstream ancestry metadata is malformed or does not prove ancestry');
  }
  if (raw.merge_base_commit.sha !== upstreamCommit) fail('Validated source commit does not descend from the claimed upstream tag');
  if (raw.status === 'identical' && upstreamCommit !== sourceCommit) fail('GitHub upstream ancestry response is inconsistent');
}

export function createValidatedReleaseInstaller(options: InstallerOptions = {}) {
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
  let activeInstall: Promise<InstallationState> | null = null;
  let status = statePayload('installed', currentVersion);
  let persistedUpdatedAt: string | null = null;

  try {
    const persisted = parsePersistedState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
    persistedUpdatedAt = persisted?.updatedAt ?? null;
    const selectedVersion = readSelectedVersion(currentLink, installRoot);
    const transactionPending = fs.existsSync(transactionPath);
    if (transactionPending && persisted && (persisted.state === 'restarting' || ACTIVE_STATES.has(persisted.state))) {
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
    void 0;
  }

  async function persist(next: InstallationState) {
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
    persistedUpdatedAt = next.updatedAt;
    await syncDirectory(installRoot);
  }

  function syncStatusFromDisk() {
    if (activeInstall) return status;
    try {
      const persisted = parsePersistedState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
      if (persisted && persisted.updatedAt !== persistedUpdatedAt) {
        persistedUpdatedAt = persisted.updatedAt;
        if (persisted.state === 'restarting' || ACTIVE_STATES.has(persisted.state)) {
          status = fs.existsSync(transactionPath)
            ? { ...persisted, state: 'restarting', currentVersion }
            : { ...persisted, state: 'failed', currentVersion, error: 'OpenChamber update restart transaction is missing' };
        } else {
          status = persisted;
        }
        options.onStateChange?.(status);
      }
    } catch {
      void 0;
    }
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
      if (hasErrorCode(error) && error.code === 'ELOCKED') fail('Another OpenChamber update owns the installation lock');
      throw error;
    }
  }

  async function releaseLock(release: () => Promise<void>) {
    await release();
    await syncDirectory(installRoot);
  }

  function noteAvailable(updateInfo: { available?: boolean; version?: string | null }) {
    if (activeInstall || !updateInfo?.available || !isString(updateInfo.version)) return;
    status = statePayload('available', currentVersion, { targetVersion: updateInfo.version });
  }

  async function resolveChannel() {
    const stableRelease = parseRelease(await fetchJson(fetchImpl, releaseApiUrl, 'GitHub release metadata', { noReleaseOn404: true, githubToken }));
    const stableCommitUrl = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(stableRelease.tag)}`;
    const stableTagCommit = parseTagCommit(await fetchJson(fetchImpl, stableCommitUrl, 'GitHub tag commit metadata', { githubToken }));
    const stableManifestAsset = getUniqueAsset(stableRelease, 'channel.json');
    validateAssetUrl(stableManifestAsset, stableRelease.tag, repository);
    const stableChannel = validateChannelMetadata(
      await fetchJson(fetchImpl, stableManifestAsset.url, 'Update channel metadata', { githubToken }),
      stableRelease,
      stableTagCommit,
      LEGACY_TARGET,
      currentVersion,
    );
    const stableAssetNames = stableRelease.assets.map((asset) => asset.name).sort();
    if (JSON.stringify(stableAssetNames) !== JSON.stringify([...stableChannel.assets].sort())) {
      fail('GitHub Release asset inventory does not match the update channel');
    }
    for (const assetName of stableChannel.assets) {
      validateAssetUrl(getUniqueAsset(stableRelease, assetName), stableRelease.tag, repository);
    }

    const upstreamTagUrl = `https://api.github.com/repos/openchamber/openchamber/commits/${encodeURIComponent(stableChannel.upstreamTag)}`;
    const upstreamCommit = parseTagCommit(await fetchJson(fetchImpl, upstreamTagUrl, 'GitHub upstream tag metadata', { githubToken }));
    const compareUrl = `https://api.github.com/repos/${repository}/compare/${upstreamCommit}...${stableChannel.sourceCommit}?per_page=1&page=2`;
    parseCompare(await fetchJson(fetchImpl, compareUrl, 'GitHub upstream ancestry metadata', { githubToken }), upstreamCommit, stableChannel.sourceCommit);

    const companionTag = `web-${stableChannel.releaseTag}`;
    const companionReleaseUrl = options.companionReleaseApiUrl || `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(companionTag)}`;
    let companionRelease;
    try {
      companionRelease = parseRelease(await fetchJson(fetchImpl, companionReleaseUrl, 'GitHub companion release metadata', { noReleaseOn404: true, githubToken }));
    } catch (error) {
      if (!(error instanceof NoValidatedReleaseError)) throw error;
      if (!targetEquals(target, LEGACY_TARGET)) {
        fail(`No validated OpenChamber companion release matches ${target.platform}/${target.arch}/ABI-${target.nodeAbi}`);
      }
      const archiveAsset = getUniqueAsset(stableRelease, stableChannel.archive.name);
      const checksumAsset = getUniqueAsset(stableRelease, stableChannel.archive.checksumName);
      if (archiveAsset.size > MAX_DOWNLOAD_BYTES) fail('GitHub archive exceeds the download limit');
      const checksumBytes = await fetchBytes(fetchImpl, checksumAsset.url, 4096, 'Checksum asset', { githubToken });
      parseChecksumFile(checksumBytes, [{ tarball: stableChannel.archive.name, sha256: stableChannel.archive.sha256 }]);
      return { channel: stableChannel, archiveAsset };
    }

    const companionCommitUrl = `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(companionTag)}`;
    const companionTagCommit = parseTagCommit(await fetchJson(fetchImpl, companionCommitUrl, 'GitHub companion tag commit metadata', { githubToken }));
    const companionManifestAsset = getUniqueAsset(companionRelease, 'channel.json');
    validateAssetUrl(companionManifestAsset, companionTag, repository);
    const channel = validateMultiTargetChannelMetadata(
      await fetchJson(fetchImpl, companionManifestAsset.url, 'Multi-target update channel metadata', { githubToken }),
      companionRelease,
      companionTagCommit,
      stableChannel,
      target,
    );
    const companionAssetNames = companionRelease.assets.map((asset) => asset.name).sort();
    if (JSON.stringify(companionAssetNames) !== JSON.stringify([...channel.assets].sort())) {
      fail('GitHub companion release asset inventory does not match the update channel');
    }
    for (const assetName of channel.assets) {
      validateAssetUrl(getUniqueAsset(companionRelease, assetName), companionTag, repository);
    }
    const checksumAsset = getUniqueAsset(companionRelease, channel.archive.checksumName);
    const checksumBytes = await fetchBytes(fetchImpl, checksumAsset.url, 4096, 'Checksum asset', { githubToken });
    parseChecksumFile(checksumBytes, channel.artifacts);
    const archiveAsset = getUniqueAsset(companionRelease, channel.archive.name);
    if (archiveAsset.size > MAX_DOWNLOAD_BYTES) fail('GitHub archive exceeds the download limit');
    return { channel, archiveAsset };
  }


  async function checkForUpdate() {
    let channel;
    try {
      ({ channel } = await resolveChannel());
    } catch (error) {
      if (error instanceof ChannelBaseOlderError) {
        await persist(statePayload('no-validated-release', currentVersion));
        return { available: false, currentVersion, version: error.version, channel: CHANNEL_ID, channelRepository: repository, noValidatedRelease: true, reason: 'channel-base-older' };
      }
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
      releaseUrl: `https://github.com/${repository}/releases/tag/${channel.schema === MULTI_TARGET_CHANNEL_SCHEMA_VERSION ? `v${channel.version}` : channel.releaseTag}`,
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

  async function beginInstall<Preparation>({ targetVersion, prepareRestart = async () => null, handoffRestart, cancelRestart = async () => {} }: InstallArguments<Preparation>) {
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
      let stagingDirectory: string | null = null;
      let archivePath: string | null = null;
      let previousTarget: string | null = null;
      let switched = false;
      let restartPrepared = false;
      let restartPreparation: Preparation | null = null;
      let channel: Channel | null = null;
      try {
        const canonicalInstallRoot = await fsp.realpath(installRoot);
        const resolved = await resolveChannel();
        channel = resolved.channel;
        if (channel.version !== targetVersion) fail('Validated release version does not match the requested update');
        const { archiveAsset } = resolved;
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
        const previousVersion = currentVersion;
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
        if (hasErrorCode(error) && error.code === 'SIMULATED_PROCESS_CRASH') throw error;
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

  async function install<Preparation>(args: InstallArguments<Preparation>) {
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
