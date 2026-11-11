#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import {
  createRelocatableArchive,
  stageRelocatablePackage,
  validateArtifactTarget,
  verifyRelocatableArchive,
} from './artifact.mjs';

const WEB_PACKAGE_PATH = resolve('packages/web/package.json');
const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANNEL_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-j2k\.([1-9]\d*)$/;
const IDENTITY_OPTIONS = ['arch', 'base-version', 'node-abi', 'platform', 'revision', 'source-commit', 'upstream-tag'];
const WEB_RELEASE_OPTIONS = ['base-version', 'output-dir', 'revision', 'source-commit', 'upstream-tag'];
const COMMAND_OPTIONS = new Map([
  ['stage-version', new Set(IDENTITY_OPTIONS)],
  ['pack', new Set([...IDENTITY_OPTIONS, 'output-dir'])],
  ['verify-release', new Set([...IDENTITY_OPTIONS, 'output-dir'])],
  ['pack-package', new Set(['arch', 'archive-name', 'node-abi', 'output-dir', 'platform', 'source-commit', 'version'])],
  ['verify-package', new Set(['arch', 'node-abi', 'platform', 'source-commit', 'tarball', 'version'])],
  ['assemble-bundle', new Set(WEB_RELEASE_OPTIONS)],
  ['verify-bundle', new Set(WEB_RELEASE_OPTIONS)],
]);
const MANIFEST_KEYS = [
  'schema',
  'baseVersion',
  'channelRevision',
  'version',
  'releaseTag',
  'tarball',
  'checksumAsset',
  'manifestAsset',
  'assets',
  'sha256',
  'upstreamTag',
  'seriesHead',
  'sourceCommit',
  'minNode',
  'platform',
  'arch',
  'nodeAbi',
];
const WEB_MANIFEST_KEYS = [
  'schema',
  'baseVersion',
  'channelRevision',
  'version',
  'releaseTag',
  'checksumAsset',
  'manifestAsset',
  'assets',
  'artifacts',
  'upstreamTag',
  'seriesHead',
  'sourceCommit',
  'minNode',
];
const WEB_ARTIFACT_KEYS = ['platform', 'arch', 'nodeAbi', 'tarball', 'sha256'];
const LEGACY_TARGET = Object.freeze({ platform: 'darwin', arch: 'arm64', nodeAbi: '127' });
const WEB_TARGETS = Object.freeze([
  LEGACY_TARGET,
  Object.freeze({ platform: 'linux', arch: 'x64', nodeAbi: '127' }),
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) fail(`Unknown command: ${command || '<missing>'}`);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    const name = key.slice(2);
    if (!allowed.has(name)) fail(`Unknown option for ${command}: --${name}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate option for ${command}: --${name}`);
    options[name] = value;
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) fail(`Missing --${name}`);
  return value;
}

function parseIdentity(options) {
  const baseVersion = requireOption(options, 'base-version');
  const revisionText = requireOption(options, 'revision');
  const upstreamTag = requireOption(options, 'upstream-tag');
  const sourceCommit = requireOption(options, 'source-commit').toLowerCase();
  const target = parseTarget(options);
  if (!BASE_VERSION_PATTERN.test(baseVersion)) fail(`Invalid base version: ${baseVersion}`);
  if (!/^[1-9]\d*$/.test(revisionText)) fail(`Invalid channel revision: ${revisionText}`);
  if (upstreamTag !== `v${baseVersion}`) fail(`Upstream tag ${upstreamTag} does not match ${baseVersion}`);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail(`Invalid source commit: ${sourceCommit}`);

  const channelRevision = Number(revisionText);
  if (!Number.isSafeInteger(channelRevision) || channelRevision < 1 || String(channelRevision) !== revisionText) {
    fail(`Invalid channel revision: ${revisionText}`);
  }
  const version = `${baseVersion}-j2k.${channelRevision}`;
  return {
    baseVersion,
    channelRevision,
    version,
    releaseTag: `v${version}`,
    upstreamTag,
    sourceCommit,
    target,
  };
}

function assertTarget(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must target ${expected.platform}/${expected.arch}/ABI-${expected.nodeAbi}`);
  }
}

function parseWebIdentity(options) {
  const identity = parseIdentity({
    ...options,
    platform: LEGACY_TARGET.platform,
    arch: LEGACY_TARGET.arch,
    'node-abi': LEGACY_TARGET.nodeAbi,
  });
  return { ...identity, releaseTag: `web-v${identity.version}` };
}

function parseTarget(options) {
  return validateArtifactTarget({
    platform: requireOption(options, 'platform'),
    arch: requireOption(options, 'arch'),
    nodeAbi: requireOption(options, 'node-abi'),
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stageVersion(identity) {
  const packageJson = readJson(WEB_PACKAGE_PATH);
  if (packageJson.version !== identity.baseVersion) {
    fail(`packages/web version ${packageJson.version} does not match base ${identity.baseVersion}`);
  }
  packageJson.version = identity.version;
  packageJson.openchamberArtifact = identity.target;
  writeFileSync(WEB_PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
  process.stdout.write(`${identity.version}\n`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packageTarballName(version, target, targetQualified) {
  return targetQualified
    ? `openchamber-web-${version}-${target.platform}-${target.arch}-abi${target.nodeAbi}.tgz`
    : `openchamber-web-${version}.tgz`;
}

async function packPackage(version, sourceCommit, target, outputDirectory, archiveName) {
  const packageJson = readJson(WEB_PACKAGE_PATH);
  if (packageJson.version !== version) {
    fail(`Stage packages/web version ${version} before packaging; found ${packageJson.version}`);
  }
  mkdirSync(outputDirectory, { recursive: true });
  if (readdirSync(outputDirectory).length !== 0) fail(`Output directory is not empty: ${outputDirectory}`);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'openchamber-channel-stage-'));
  const stagingRoot = join(temporaryRoot, 'package');
  const tarballName = archiveName || packageTarballName(version, target, false);
  if (archiveName && archiveName !== packageTarballName(version, target, true)) {
    fail(`Target-qualified archive name must be ${packageTarballName(version, target, true)}`);
  }
  const tarballPath = resolve(outputDirectory, tarballName);
  try {
    stageRelocatablePackage({
      repositoryRoot: resolve('.'),
      packageRoot: resolve('packages/web'),
      stagingRoot,
      sourceCommit,
      target,
    });
    await createRelocatableArchive(stagingRoot, tarballPath);
    verifyRelocatableArchive(tarballPath, { expectedVersion: version, sourceCommit, target });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return { tarballName, tarballPath };
}

async function pack(identity, outputDirectory) {
  assertTarget(identity.target, LEGACY_TARGET, 'Schema-1 release');
  const { tarballName, tarballPath } = await packPackage(identity.version, identity.sourceCommit, identity.target, outputDirectory);
  const digest = sha256(tarballPath);
  const assets = [tarballName, 'SHA256SUMS', 'channel.json'];
  const manifest = {
    schema: 1,
    baseVersion: identity.baseVersion,
    channelRevision: identity.channelRevision,
    version: identity.version,
    releaseTag: identity.releaseTag,
    tarball: tarballName,
    checksumAsset: 'SHA256SUMS',
    manifestAsset: 'channel.json',
    assets,
    sha256: digest,
    upstreamTag: identity.upstreamTag,
    seriesHead: identity.sourceCommit,
    sourceCommit: identity.sourceCommit,
    minNode: '22',
    platform: identity.target.platform,
    arch: identity.target.arch,
    nodeAbi: identity.target.nodeAbi,
  };
  writeFileSync(resolve(outputDirectory, 'SHA256SUMS'), `${digest}  ${tarballName}\n`);
  writeFileSync(resolve(outputDirectory, 'channel.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyRelease(identity, outputDirectory);
  process.stdout.write(`${tarballPath}\n`);
}

function verifyExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys or key order differ: ${actual.join(', ')}`);
  }
}

function verifyRelease(identity, outputDirectory) {
  assertTarget(identity.target, LEGACY_TARGET, 'Schema-1 release');
  const manifestPath = resolve(outputDirectory, 'channel.json');
  const checksumPath = resolve(outputDirectory, 'SHA256SUMS');
  const manifest = readJson(manifestPath);
  verifyExactKeys(manifest, MANIFEST_KEYS, 'channel.json');

  const tarballName = `openchamber-web-${identity.version}.tgz`;
  const assetNames = [tarballName, 'SHA256SUMS', 'channel.json'];
  const actualNames = readdirSync(outputDirectory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...assetNames].sort())) {
    fail(`Release output contains unexpected assets: ${actualNames.join(', ')}`);
  }
  const expected = {
    schema: 1,
    baseVersion: identity.baseVersion,
    channelRevision: identity.channelRevision,
    version: identity.version,
    releaseTag: identity.releaseTag,
    tarball: tarballName,
    checksumAsset: 'SHA256SUMS',
    manifestAsset: 'channel.json',
    assets: assetNames,
    upstreamTag: identity.upstreamTag,
    seriesHead: identity.sourceCommit,
    sourceCommit: identity.sourceCommit,
    minNode: '22',
    platform: identity.target.platform,
    arch: identity.target.arch,
    nodeAbi: identity.target.nodeAbi,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) fail(`channel.json ${key} does not match release identity`);
  }

  const tarballPath = resolve(outputDirectory, tarballName);
  const digest = sha256(tarballPath);
  if (manifest.sha256 !== digest) fail('channel.json sha256 does not match the tarball');
  const checksum = readFileSync(checksumPath, 'utf8');
  if (checksum !== `${digest}  ${tarballName}\n`) fail('SHA256SUMS must contain exactly the release tarball checksum');
  verifyRelocatableArchive(tarballPath, { expectedVersion: identity.version, sourceCommit: identity.sourceCommit, target: identity.target });
}

function webArtifact(identity, target, path) {
  const tarball = packageTarballName(identity.version, target, true);
  return { platform: target.platform, arch: target.arch, nodeAbi: target.nodeAbi, tarball, sha256: sha256(path) };
}

function verifyWebRelease(identity, outputDirectory) {
  const manifest = readJson(resolve(outputDirectory, 'channel.json'));
  verifyExactKeys(manifest, WEB_MANIFEST_KEYS, 'channel.json');
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== WEB_TARGETS.length) {
    fail('channel.json artifacts must contain exactly the supported web targets');
  }

  const artifacts = WEB_TARGETS.map((target, index) => {
    const artifact = manifest.artifacts[index];
    verifyExactKeys(artifact, WEB_ARTIFACT_KEYS, `channel.json artifacts[${index}]`);
    assertTarget({ platform: artifact.platform, arch: artifact.arch, nodeAbi: artifact.nodeAbi }, target, `channel.json artifacts[${index}]`);
    const tarball = packageTarballName(identity.version, target, true);
    if (artifact.tarball !== tarball) fail(`channel.json artifacts[${index}] has the wrong tarball name`);
    const tarballPath = resolve(outputDirectory, tarball);
    const digest = sha256(tarballPath);
    if (artifact.sha256 !== digest) fail(`channel.json artifacts[${index}] checksum does not match`);
    verifyRelocatableArchive(tarballPath, { expectedVersion: identity.version, sourceCommit: identity.sourceCommit, target });
    return { ...artifact, digest };
  });

  const tarballs = artifacts.map((artifact) => artifact.tarball);
  const assets = [...tarballs, 'SHA256SUMS', 'channel.json'];
  const expected = {
    schema: 2,
    baseVersion: identity.baseVersion,
    channelRevision: identity.channelRevision,
    version: identity.version,
    releaseTag: identity.releaseTag,
    checksumAsset: 'SHA256SUMS',
    manifestAsset: 'channel.json',
    assets,
    upstreamTag: identity.upstreamTag,
    seriesHead: identity.sourceCommit,
    sourceCommit: identity.sourceCommit,
    minNode: '22',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) fail(`channel.json ${key} does not match web release identity`);
  }
  const actualNames = readdirSync(outputDirectory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...assets].sort())) {
    fail(`Web release output contains unexpected assets: ${actualNames.join(', ')}`);
  }
  const checksums = artifacts.map((artifact) => `${artifact.digest}  ${artifact.tarball}`).join('\n') + '\n';
  if (readFileSync(resolve(outputDirectory, 'SHA256SUMS'), 'utf8') !== checksums) {
    fail('SHA256SUMS must contain exactly the ordered web artifact checksums');
  }
}

function assembleBundle(identity, outputDirectory) {
  const expectedInputs = WEB_TARGETS.map((target) => packageTarballName(identity.version, target, true));
  const actualInputs = readdirSync(outputDirectory).sort();
  if (JSON.stringify(actualInputs) !== JSON.stringify([...expectedInputs].sort())) {
    fail(`Bundle input must contain exactly the target archives: ${actualInputs.join(', ')}`);
  }
  const artifacts = WEB_TARGETS.map((target) => {
    const tarball = packageTarballName(identity.version, target, true);
    const destination = resolve(outputDirectory, tarball);
    verifyRelocatableArchive(destination, { expectedVersion: identity.version, sourceCommit: identity.sourceCommit, target });
    return webArtifact(identity, target, destination);
  });
  const assets = [...artifacts.map((artifact) => artifact.tarball), 'SHA256SUMS', 'channel.json'];
  const manifest = {
    schema: 2,
    baseVersion: identity.baseVersion,
    channelRevision: identity.channelRevision,
    version: identity.version,
    releaseTag: identity.releaseTag,
    checksumAsset: 'SHA256SUMS',
    manifestAsset: 'channel.json',
    assets,
    artifacts,
    upstreamTag: identity.upstreamTag,
    seriesHead: identity.sourceCommit,
    sourceCommit: identity.sourceCommit,
    minNode: '22',
  };
  writeFileSync(resolve(outputDirectory, 'SHA256SUMS'), `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.tarball}`).join('\n')}\n`);
  writeFileSync(resolve(outputDirectory, 'channel.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyWebRelease(identity, outputDirectory);
}

function verifyPackage(options) {
  const tarball = resolve(requireOption(options, 'tarball'));
  const version = requireOption(options, 'version');
  const sourceCommit = requireOption(options, 'source-commit');
  const target = parseTarget(options);
  const channelMatch = version.match(CHANNEL_VERSION_PATTERN);
  if (!BASE_VERSION_PATTERN.test(version) && !channelMatch) fail(`Invalid package version: ${version}`);
  if (channelMatch) {
    const revision = Number(channelMatch[4]);
    if (!Number.isSafeInteger(revision) || revision < 1 || String(revision) !== channelMatch[4]) fail(`Invalid package version: ${version}`);
  }
  verifyRelocatableArchive(tarball, { expectedVersion: version, sourceCommit, target });
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'verify-package') return verifyPackage(options);
  if (command === 'pack-package') {
    const version = requireOption(options, 'version');
    const sourceCommit = requireOption(options, 'source-commit');
    const target = parseTarget(options);
    const outputDirectory = resolve(requireOption(options, 'output-dir'));
    return packPackage(version, sourceCommit, target, outputDirectory, options['archive-name']);
  }
  if (command === 'assemble-bundle' || command === 'verify-bundle') {
    const identity = parseWebIdentity(options);
    const outputDirectory = resolve(requireOption(options, 'output-dir'));
    return command === 'assemble-bundle'
      ? assembleBundle(identity, outputDirectory)
      : verifyWebRelease(identity, outputDirectory);
  }
  const identity = parseIdentity(options);
  if (command === 'stage-version') return stageVersion(identity);
  const outputDirectory = resolve(requireOption(options, 'output-dir'));
  if (command === 'pack') return await pack(identity, outputDirectory);
  if (command === 'verify-release') return verifyRelease(identity, outputDirectory);
  fail('Usage: channel-release.mjs <stage-version|pack|pack-package|verify-package|verify-release> [options]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
