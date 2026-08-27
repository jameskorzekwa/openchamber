#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DESKTOP_TAG_PATTERN = /^desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-j2k\.([1-9]\d*)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_BASE_URL = 'https://github.com/jameskorzekwa/openchamber/releases/download';
const VERSION_PACKAGE_PATHS = [
  'package.json',
  'packages/electron/package.json',
  'packages/ui/package.json',
  'packages/web/package.json',
];
const COMMAND_OPTIONS = new Map([
  ['stage-version', new Set(['base-version', 'revision', 'source-commit'])],
  ['prepare-release', new Set([
    'base-version', 'certificate-sha256', 'dist-dir', 'electron-version', 'opencode-version', 'output-dir',
    'release-date', 'revision', 'source-commit',
  ])],
  ['verify-release', new Set([
    'base-version', 'certificate-sha256', 'electron-version', 'opencode-version', 'output-dir', 'revision', 'source-commit',
  ])],
]);

const fail = (message) => { throw new Error(message); };

export const parseDesktopTag = (tag) => {
  const match = String(tag).match(DESKTOP_TAG_PATTERN);
  if (!match) fail(`Invalid desktop release tag: ${tag}`);
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || String(revision) !== match[2]) fail(`Invalid desktop release tag: ${tag}`);
  return { baseVersion: match[1], revision, version: `${match[1]}-j2k.${revision}`, tag };
};

export const desktopIdentity = ({ baseVersion, revision, sourceCommit }) => {
  if (!BASE_VERSION_PATTERN.test(baseVersion)) fail(`Invalid base version: ${baseVersion}`);
  if (!Number.isSafeInteger(revision) || revision < 1) fail(`Invalid desktop channel revision: ${revision}`);
  if (!COMMIT_PATTERN.test(sourceCommit)) fail(`Invalid source commit: ${sourceCommit}`);
  const version = `${baseVersion}-j2k.${revision}`;
  return { baseVersion, revision, version, tag: `desktop-v${version}`, sourceCommit };
};

export const resolveNextIdentity = ({ baseVersion, sourceCommit, tags }) => {
  const matching = [];
  let highestRevision = 0;
  for (const entry of tags) {
    const parsed = parseDesktopTag(entry.tag);
    if (parsed.baseVersion !== baseVersion) continue;
    highestRevision = Math.max(highestRevision, parsed.revision);
    if (entry.commit === sourceCommit) matching.push(parsed);
  }
  if (matching.length > 1) fail(`Multiple desktop release tags point to source commit ${sourceCommit}`);
  if (matching.length === 1) return { ...desktopIdentity({ baseVersion, revision: matching[0].revision, sourceCommit }), resume: true };
  return { ...desktopIdentity({ baseVersion, revision: highestRevision + 1, sourceCommit }), resume: false };
};

export const expectedAssetNames = (version) => [
  `OpenChamber-${version}-mac-arm64.dmg`,
  `OpenChamber-${version}-mac-arm64.zip`,
  `OpenChamber-${version}-mac-arm64.zip.blockmap`,
  'latest-mac.yml',
  'SHA256SUMS',
  'desktop-release.json',
];

export const planDraftRetry = ({ expectedNames, existingNames, draft }) => {
  const expected = new Set(expectedNames);
  const existing = new Set(existingNames);
  if (existing.size !== existingNames.length) fail('Release contains duplicate asset names');
  for (const name of existing) if (!expected.has(name)) fail(`Unexpected desktop release asset ${name}`);
  const missing = expectedNames.filter((name) => !existing.has(name));
  if (missing.length > 0 && !draft) fail(`Published desktop release is missing ${missing.join(', ')}`);
  return missing;
};

export const assertBranchLease = ({ expected, current }) => {
  if (expected !== current) fail(`desktop-channel moved from ${expected || '(absent)'} to ${current || '(absent)'}`);
};

const sha = (algorithm, path, encoding) => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const sha256 = (path) => sha('sha256', path, 'hex');
const sha512 = (path) => sha('sha512', path, 'base64');

const parseArgs = (argv) => {
  const [command, ...tokens] = argv;
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) fail(`Unknown command: ${command || '<missing>'}`);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    const value = tokens[index + 1];
    if (!token?.startsWith('--') || value === undefined) fail(`Invalid argument near ${token || '<end>'}`);
    const name = token.slice(2);
    if (!allowed.has(name)) fail(`Unknown option for ${command}: --${name}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate option for ${command}: --${name}`);
    options[name] = value;
  }
  return { command, options };
};

const required = (options, name) => options[name] || fail(`Missing --${name}`);
const certificateFingerprint = (options) => {
  const fingerprint = required(options, 'certificate-sha256').replaceAll(':', '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(fingerprint)) fail('Invalid private signing certificate SHA-256 fingerprint');
  return fingerprint;
};
const identityFromOptions = (options) => desktopIdentity({
  baseVersion: required(options, 'base-version'),
  revision: Number(required(options, 'revision')),
  sourceCommit: required(options, 'source-commit').toLowerCase(),
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const stageVersion = (identity) => {
  for (const packagePath of VERSION_PACKAGE_PATHS) {
    const packageJson = readJson(resolve(packagePath));
    if (packageJson.version !== identity.baseVersion) {
      fail(`${packagePath} version ${packageJson.version} does not match base ${identity.baseVersion}`);
    }
    packageJson.version = identity.version;
    writeFileSync(resolve(packagePath), `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  process.stdout.write(`${identity.version}\n`);
};

const releaseUrl = (identity, asset) => `${RELEASE_BASE_URL}/${identity.tag}/${asset}`;

export const createMacManifest = ({ identity, zipName, zipPath, releaseDate }) => {
  if (Number.isNaN(Date.parse(releaseDate))) fail(`Invalid release date: ${releaseDate}`);
  const url = releaseUrl(identity, zipName);
  const digest = sha512(zipPath);
  const size = statSync(zipPath).size;
  return [
    `version: ${identity.version}`,
    'files:',
    `  - url: ${url}`,
    `    sha512: ${digest}`,
    `    size: ${size}`,
    `path: ${url}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date(releaseDate).toISOString()}'`,
    '',
  ].join('\n');
};

const artifactRecords = (directory, names) => names.map((name) => {
  const path = join(directory, name);
  return { name, size: statSync(path).size, sha256: sha256(path) };
});

const prepareRelease = (identity, options) => {
  const distDirectory = resolve(required(options, 'dist-dir'));
  const outputDirectory = resolve(required(options, 'output-dir'));
  mkdirSync(outputDirectory, { recursive: true });
  if (readdirSync(outputDirectory).length !== 0) fail(`Output directory is not empty: ${outputDirectory}`);

  const [dmgName, zipName, blockmapName] = expectedAssetNames(identity.version);
  for (const name of [dmgName, zipName, blockmapName]) copyFileSync(join(distDirectory, name), join(outputDirectory, name));
  writeFileSync(
    join(outputDirectory, 'latest-mac.yml'),
    createMacManifest({
      identity,
      zipName,
      zipPath: join(outputDirectory, zipName),
      releaseDate: required(options, 'release-date'),
    }),
  );

  const payloadNames = [dmgName, zipName, blockmapName, 'latest-mac.yml'];
  const files = artifactRecords(outputDirectory, payloadNames);
  writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${files.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`);
  const metadata = {
    schema: 1,
    version: identity.version,
    releaseTag: identity.tag,
    sourceCommit: identity.sourceCommit,
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: required(options, 'electron-version'),
    opencodeVersion: required(options, 'opencode-version'),
    files,
    signature: {
      type: 'private-self-signed',
      certificateSha256: certificateFingerprint(options),
      hardenedRuntime: true,
      notarized: false,
      stapled: false,
    },
  };
  writeFileSync(join(outputDirectory, 'desktop-release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  verifyRelease(identity, options);
};

const parseManifest = (content) => {
  const get = (pattern, name) => content.match(pattern)?.[1] || fail(`latest-mac.yml is missing ${name}`);
  return {
    version: get(/^version:\s*(\S+)\s*$/m, 'version'),
    fileUrl: get(/^\s*- url:\s*(\S+)\s*$/m, 'files URL'),
    fileSha512: get(/^\s+sha512:\s*(\S+)\s*$/m, 'file sha512'),
    fileSize: Number(get(/^\s+size:\s*(\d+)\s*$/m, 'file size')),
    path: get(/^path:\s*(\S+)\s*$/m, 'path'),
    sha512: get(/^sha512:\s*(\S+)\s*$/m, 'sha512'),
  };
};

const verifyRelease = (identity, options) => {
  const outputDirectory = resolve(required(options, 'output-dir'));
  const expectedNames = expectedAssetNames(identity.version);
  const actualNames = readdirSync(outputDirectory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    fail(`Desktop release contains unexpected assets: ${actualNames.join(', ')}`);
  }
  const [dmgName, zipName, blockmapName] = expectedNames;
  const manifestPath = join(outputDirectory, 'latest-mac.yml');
  const manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  const immutableZipUrl = releaseUrl(identity, zipName);
  if (manifest.version !== identity.version) fail('latest-mac.yml version does not match release identity');
  if (manifest.fileUrl !== immutableZipUrl || manifest.path !== immutableZipUrl) {
    fail('latest-mac.yml must use the immutable absolute GitHub release ZIP URL');
  }
  const zipPath = join(outputDirectory, zipName);
  const expectedSha512 = sha512(zipPath);
  if (manifest.fileSha512 !== expectedSha512 || manifest.sha512 !== expectedSha512) fail('latest-mac.yml sha512 does not match ZIP');
  if (manifest.fileSize !== statSync(zipPath).size) fail('latest-mac.yml size does not match ZIP');
  if (readFileSync(manifestPath, 'utf8').includes('raw.githubusercontent.com')) fail('latest-mac.yml must not resolve binaries through the feed host');

  const payloadNames = [dmgName, zipName, blockmapName, 'latest-mac.yml'];
  const records = artifactRecords(outputDirectory, payloadNames);
  const expectedChecksums = `${records.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`;
  if (readFileSync(join(outputDirectory, 'SHA256SUMS'), 'utf8') !== expectedChecksums) fail('SHA256SUMS does not match release payloads');

  const metadata = readJson(join(outputDirectory, 'desktop-release.json'));
  const expectedKeys = ['arch', 'electronVersion', 'files', 'opencodeVersion', 'platform', 'releaseTag', 'schema', 'signature', 'sourceCommit', 'version'];
  if (JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)) fail('desktop-release.json keys differ from the contract');
  if (metadata.schema !== 1 || metadata.version !== identity.version || metadata.releaseTag !== identity.tag
    || metadata.sourceCommit !== identity.sourceCommit || metadata.platform !== 'darwin' || metadata.arch !== 'arm64') {
    fail('desktop-release.json identity does not match the release');
  }
  if (metadata.electronVersion !== required(options, 'electron-version')
    || metadata.opencodeVersion !== required(options, 'opencode-version')) fail('desktop-release.json dependency versions differ');
  if (JSON.stringify(metadata.files) !== JSON.stringify(records)) fail('desktop-release.json file inventory differs');
  const signature = metadata.signature;
  if (!signature || Object.keys(signature).sort().join(',') !== 'certificateSha256,hardenedRuntime,notarized,stapled,type'
    || signature.type !== 'private-self-signed' || signature.certificateSha256 !== certificateFingerprint(options)
    || signature.hardenedRuntime !== true || signature.notarized !== false || signature.stapled !== false) {
    fail('desktop-release.json signature metadata is invalid');
  }
};

const main = () => {
  const { command, options } = parseArgs(process.argv.slice(2));
  const identity = identityFromOptions(options);
  if (command === 'stage-version') return stageVersion(identity);
  if (command === 'prepare-release') return prepareRelease(identity, options);
  return verifyRelease(identity, options);
};

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
