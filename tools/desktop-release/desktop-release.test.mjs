import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createMacManifest,
  desktopIdentity,
  expectedAssetNames,
  assertBranchLease,
  parseDesktopTag,
  planDraftRetry,
  resolveNextIdentity,
} from './desktop-release.mjs';

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const certificateSha256 = 'A'.repeat(64);
const script = resolve('tools/desktop-release/desktop-release.mjs');

test('parses only canonical desktop versions and tags', () => {
  assert.deepEqual(parseDesktopTag('desktop-v1.21.0-j2k.7'), {
    baseVersion: '1.21.0',
    revision: 7,
    version: '1.21.0-j2k.7',
    tag: 'desktop-v1.21.0-j2k.7',
  });
  for (const tag of ['v1.21.0-j2k.7', 'desktop-v1.21-j2k.7', 'desktop-v1.21.0-j2k.0', 'desktop-v01.21.0-j2k.1']) {
    assert.throws(() => parseDesktopTag(tag), /Invalid desktop release tag/);
  }
});

test('resumes one exact source identity or allocates the next series revision', () => {
  assert.deepEqual(resolveNextIdentity({
    baseVersion: '1.21.0',
    sourceCommit,
    tags: [
      { tag: 'desktop-v1.21.0-j2k.2', commit: 'a'.repeat(40) },
      { tag: 'desktop-v1.21.0-j2k.4', commit: sourceCommit },
      { tag: 'desktop-v1.20.0-j2k.9', commit: 'b'.repeat(40) },
    ],
  }), { ...desktopIdentity({ baseVersion: '1.21.0', revision: 4, sourceCommit }), resume: true });
  assert.equal(resolveNextIdentity({
    baseVersion: '1.21.0', sourceCommit, tags: [{ tag: 'desktop-v1.21.0-j2k.4', commit: 'a'.repeat(40) }],
  }).revision, 5);
  assert.throws(() => resolveNextIdentity({
    baseVersion: '1.21.0',
    sourceCommit,
    tags: [
      { tag: 'desktop-v1.21.0-j2k.1', commit: sourceCommit },
      { tag: 'desktop-v1.21.0-j2k.2', commit: sourceCommit },
    ],
  }), /Multiple desktop release tags/);
});

test('stages the canonical version in every Electron-owned package identity', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-version-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ['package.json', 'packages/electron/package.json', 'packages/ui/package.json', 'packages/web/package.json']) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), '{"name":"fixture","version":"1.21.0"}\n');
  }
  const result = spawnSync(process.execPath, [script, 'stage-version',
    '--base-version', '1.21.0', '--revision', '3', '--source-commit', sourceCommit,
  ], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['package.json', 'packages/electron/package.json', 'packages/ui/package.json', 'packages/web/package.json']) {
    assert.equal(JSON.parse(readFileSync(join(directory, path), 'utf8')).version, '1.21.0-j2k.3');
  }
});

test('creates an absolute immutable macOS update manifest', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-manifest-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const zipPath = join(directory, 'OpenChamber-1.21.0-j2k.3-mac-arm64.zip');
  writeFileSync(zipPath, 'zip fixture');
  const identity = desktopIdentity({ baseVersion: '1.21.0', revision: 3, sourceCommit });
  const manifest = createMacManifest({
    identity,
    zipName: expectedAssetNames(identity.version)[1],
    zipPath,
    releaseDate: '2026-08-27T12:00:00Z',
  });
  const immutableUrl = 'https://github.com/jameskorzekwa/openchamber/releases/download/desktop-v1.21.0-j2k.3/OpenChamber-1.21.0-j2k.3-mac-arm64.zip';
  assert.match(manifest, new RegExp(`- url: ${immutableUrl.replaceAll('.', '\\.')}`));
  assert.match(manifest, new RegExp(`path: ${immutableUrl.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(manifest, /raw\.githubusercontent\.com/);
});

test('verifies inventory, checksums, signature metadata, and rejects partial retry drift', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-release-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dist = join(directory, 'dist');
  const output = join(directory, 'artifacts');
  mkdirSync(dist);
  const version = '1.21.0-j2k.3';
  for (const name of expectedAssetNames(version).slice(0, 3)) writeFileSync(join(dist, name), `fixture ${name}`);
  const common = [
    '--base-version', '1.21.0', '--revision', '3', '--source-commit', sourceCommit,
    '--electron-version', '43.3.0', '--opencode-version', '1.18.23', '--output-dir', output,
    '--certificate-sha256', certificateSha256,
  ];
  const prepared = spawnSync(process.execPath, [script, 'prepare-release', ...common,
    '--dist-dir', dist, '--release-date', '2026-08-27T12:00:00Z',
  ], { encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const verified = spawnSync(process.execPath, [script, 'verify-release', ...common], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr);
  writeFileSync(join(output, expectedAssetNames(version)[0]), 'different bytes');
  const drifted = spawnSync(process.execPath, [script, 'verify-release', ...common], { encoding: 'utf8' });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /SHA256SUMS does not match/);
});

test('plans partial draft retries without permitting published or unexpected mutations', () => {
  const expected = expectedAssetNames('1.21.0-j2k.3');
  assert.deepEqual(planDraftRetry({ expectedNames: expected, existingNames: expected.slice(0, 2), draft: true }), expected.slice(2));
  assert.deepEqual(planDraftRetry({ expectedNames: expected, existingNames: expected, draft: false }), []);
  assert.throws(() => planDraftRetry({ expectedNames: expected, existingNames: expected.slice(0, 2), draft: false }), /Published desktop release is missing/);
  assert.throws(() => planDraftRetry({ expectedNames: expected, existingNames: [...expected, 'other.zip'], draft: true }), /Unexpected desktop release asset/);
  assert.throws(() => planDraftRetry({ expectedNames: expected, existingNames: [expected[0], expected[0]], draft: true }), /duplicate asset names/);
});

test('requires an exact desktop-channel branch lease', () => {
  assert.doesNotThrow(() => assertBranchLease({ expected: sourceCommit, current: sourceCommit }));
  assert.doesNotThrow(() => assertBranchLease({ expected: '', current: '' }));
  assert.throws(() => assertBranchLease({ expected: sourceCommit, current: 'f'.repeat(40) }), /desktop-channel moved/);
});
