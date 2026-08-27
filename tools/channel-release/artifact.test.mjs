import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  ARCHIVE_LIMITS,
  createRelocatableArchive,
  verifyRelocatableArchive,
} from './artifact.mjs';

const version = '1.21.0-j2k.1';
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const target = { platform: 'darwin', arch: 'arm64', nodeAbi: process.versions.modules };

function writePackage(directory, packageJson) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'channel-artifact-test-'));
  const packageRoot = join(root, 'package');
  writePackage(packageRoot, {
    name: '@openchamber/web',
    version,
    bin: { openchamber: './bin/cli.js' },
    dependencies: { 'dep-a': '1.0.0' },
    openchamberArtifact: target,
  });
  for (const path of ['bin', 'server', 'dist', 'node_modules']) mkdirSync(join(packageRoot, path), { recursive: true });
  writeFileSync(join(packageRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(packageRoot, 'server', 'index.js'), 'export {};\n');
  writeFileSync(join(packageRoot, 'dist', 'index.html'), '<!doctype html>\n');
  writeFileSync(join(packageRoot, 'dist', 'build-revision.json'), JSON.stringify({ revision: sourceCommit }));
  writePackage(join(packageRoot, 'node_modules', 'dep-a'), { name: 'dep-a', version: '1.0.0', dependencies: { 'dep-b': '1.0.0' } });
  writePackage(join(packageRoot, 'node_modules', 'dep-b'), { name: 'dep-b', version: '1.0.0' });
  return { root, packageRoot, archive: join(root, 'artifact.tgz') };
}

function writeOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarEntry(name, content = '', type = '0', declaredSize) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  writeOctal(header, 100, 8, type === '5' ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, declaredSize ?? data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar', 257, 5, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function maliciousArchive(root, entries) {
  const archive = join(root, 'malicious.tgz');
  writeFileSync(archive, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { mtime: 0 }));
  return archive;
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  return `${length} ${body}`;
}

test('creates and verifies a bounded archive with transitive dependencies', async () => {
  const value = fixture();
  try {
    const created = await createRelocatableArchive(value.packageRoot, value.archive);
    const verified = verifyRelocatableArchive(value.archive, { expectedVersion: version, sourceCommit, target });
    const second = join(value.root, 'artifact-second.tgz');
    await createRelocatableArchive(value.packageRoot, second);
    assert.ok(created.compressedBytes <= ARCHIVE_LIMITS.compressedBytes);
    assert.equal(verified.revision, sourceCommit);
    assert.deepEqual(readFileSync(second), readFileSync(value.archive));
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects a missing transitive dependency', async () => {
  const value = fixture();
  try {
    rmSync(join(value.packageRoot, 'node_modules', 'dep-b'), { recursive: true });
    await createRelocatableArchive(value.packageRoot, value.archive);
    assert.throws(() => verifyRelocatableArchive(value.archive, { expectedVersion: version, sourceCommit, target }), /missing required dependency dep-b/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects package target metadata and incompatible dependency platforms', async () => {
  const value = fixture();
  try {
    const rootPackage = JSON.parse(readFileSync(join(value.packageRoot, 'package.json'), 'utf8'));
    rootPackage.openchamberArtifact = { platform: 'linux', arch: 'arm64', nodeAbi: target.nodeAbi };
    writeFileSync(join(value.packageRoot, 'package.json'), JSON.stringify(rootPackage));
    await createRelocatableArchive(value.packageRoot, value.archive);
    assert.throws(() => verifyRelocatableArchive(value.archive, { expectedVersion: version, sourceCommit, target }), /target metadata does not match/);
    rmSync(value.archive);

    rootPackage.openchamberArtifact = target;
    writeFileSync(join(value.packageRoot, 'package.json'), JSON.stringify(rootPackage));
    const dependencyPath = join(value.packageRoot, 'node_modules', 'dep-a', 'package.json');
    const dependency = JSON.parse(readFileSync(dependencyPath, 'utf8'));
    dependency.os = ['linux'];
    writeFileSync(dependencyPath, JSON.stringify(dependency));
    await createRelocatableArchive(value.packageRoot, value.archive);
    assert.throws(() => verifyRelocatableArchive(value.archive, { expectedVersion: version, sourceCommit, target }), /does not support darwin/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('refuses symlinks before archive creation', async () => {
  const value = fixture();
  try {
    symlinkSync('package.json', join(value.packageRoot, 'link'));
    await assert.rejects(createRelocatableArchive(value.packageRoot, value.archive), /symlink/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejects links, devices, fifos, traversal, duplicates, and oversized entries', () => {
  const value = fixture();
  try {
    for (const [label, entry, pattern] of [
      ['hardlink', tarEntry('package/hard', 'package/package.json', '1'), /type 1/],
      ['device', tarEntry('package/device', '', '3'), /type 3/],
      ['fifo', tarEntry('package/fifo', '', '6'), /type 6/],
      ['traversal', tarEntry('package/../escape', 'x'), /Unsafe archive path/],
      ['oversized', tarEntry('package/large', '', '0', ARCHIVE_LIMITS.fileBytes + 1), /exceeds 128 MiB/],
      ['oversized metadata', tarEntry('PaxHeader', '', 'x', ARCHIVE_LIMITS.metadataBytes + 1), /metadata exceeds 64 KiB/],
      ['unsupported pax', tarEntry('PaxHeader', paxRecord('size', '1'), 'x'), /unsupported PAX metadata/],
    ]) {
      const archive = maliciousArchive(value.root, [entry]);
      assert.throws(() => verifyRelocatableArchive(archive, { target }), pattern, label);
      rmSync(archive);
    }
    const duplicate = maliciousArchive(value.root, [tarEntry('package/file', 'a'), tarEntry('package/file', 'b')]);
    assert.throws(() => verifyRelocatableArchive(duplicate, { target }), /duplicate/);
    rmSync(duplicate);
    const fileDirectoryCollision = maliciousArchive(value.root, [
      tarEntry('package/collision', 'file'),
      tarEntry('package/collision/', '', '5'),
    ]);
    assert.throws(() => verifyRelocatableArchive(fileDirectoryCollision, { target }), /duplicate/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
