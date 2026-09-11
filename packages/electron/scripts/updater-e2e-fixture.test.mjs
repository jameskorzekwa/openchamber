import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureServer, stageMacUpdaterFixture, stageUpdaterFixture } from './updater-e2e-fixture.mjs';
import { parseUpdateManifest, verifyUpdateManifest } from './verify-update-manifest.mjs';

test('stages architecture-specific generic updater fixtures with valid metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-updater-fixture-'));
  try {
    const source = path.join(root, 'OpenChamber-1.15.1-linux-arm64.AppImage');
    const directory = path.join(root, 'feed');
    fs.writeFileSync(source, 'fixture-appimage');
    const result = stageUpdaterFixture({
      architecture: 'arm64',
      nextAppImage: source,
      version: '1.15.1',
      directory,
    });
    assert.equal(result.manifestName, 'latest-linux-arm64.yml');
    const manifestPath = path.join(directory, result.manifestName);
    assert.deepEqual(parseUpdateManifest(fs.readFileSync(manifestPath, 'utf8')).files.length, 1);
    assert.deepEqual(verifyUpdateManifest({
      manifestPath,
      artifactPath: result.artifactPath,
      expectedVersion: '1.15.1',
    }), {
      name: 'OpenChamber-1.15.1-linux-arm64.AppImage',
      size: 16,
      version: '1.15.1',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('serves only staged fixture files over loopback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-updater-server-'));
  const artifact = path.join(root, 'OpenChamber.AppImage');
  fs.writeFileSync(artifact, 'fixture');
  const { server, url } = await createFixtureServer({ directory: root });
  try {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(`${url}OpenChamber.AppImage`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'fixture');
    assert.equal((await fetch(`${url}../package.json`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stages a macOS updater fixture from the exact ZIP payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-macos-updater-fixture-'));
  try {
    const source = path.join(root, 'OpenChamber-1.21.0-j2k.27-mac-arm64.zip');
    fs.writeFileSync(source, 'signed zip fixture');
    const result = stageMacUpdaterFixture({
      nextZip: source,
      version: '1.21.0-j2k.27',
      directory: path.join(root, 'feed'),
    });
    assert.equal(result.manifestName, 'latest-mac.yml');
    assert.deepEqual(verifyUpdateManifest({
      manifestPath: path.join(root, 'feed', 'latest-mac.yml'),
      artifactPath: result.artifactPath,
      expectedVersion: '1.21.0-j2k.27',
    }), {
      name: path.basename(source),
      size: 18,
      version: '1.21.0-j2k.27',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Test that exercises the check→download path using a local fixture server.
// This validates that:
// 1. The fixture server correctly serves the manifest and artifact
// 2. The manifest contains the expected checksum for download verification
// 3. The artifact can be fetched and verified against the manifest
test('check→download path: fixture server enables full update cycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-updater-download-'));
  try {
    // Create a realistic ZIP artifact fixture (similar to macOS update)
    const version = '1.21.0-j2k.23';
    const artifactName = `OpenChamber-${version}-mac-arm64.zip`;
    const artifactPath = path.join(root, artifactName);
    const artifactContent = Buffer.from('mock-zip-contents-for-test');
    fs.writeFileSync(artifactPath, artifactContent);

    // Compute the expected sha512 checksum
    const expectedSha512 = crypto.createHash('sha512').update(artifactContent).digest('base64');

    // Create a macOS-style manifest (latest-mac.yml format)
    const manifestContent = [
      `version: ${version}`,
      'files:',
      `  - url: ${encodeURIComponent(artifactName)}`,
      `    sha512: ${expectedSha512}`,
      `    size: ${artifactContent.length}`,
      `path: ${encodeURIComponent(artifactName)}`,
      `sha512: ${expectedSha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'latest-mac.yml'), manifestContent);

    // Start the fixture server
    const { server, url } = await createFixtureServer({ directory: root });
    try {
      // CHECK phase: fetch manifest and verify structure
      const manifestResponse = await fetch(`${url}latest-mac.yml`);
      assert.equal(manifestResponse.status, 200, 'manifest should be served');
      const fetchedManifest = await manifestResponse.text();
      const parsed = parseUpdateManifest(fetchedManifest);
      assert.equal(parsed.version, version, 'manifest version should match');
      assert.equal(parsed.files.length, 1, 'manifest should have one file entry');
      assert.equal(parsed.files[0].sha512, expectedSha512, 'manifest sha512 should match artifact');
      assert.equal(parsed.files[0].size, artifactContent.length, 'manifest size should match artifact');

      // DOWNLOAD phase: fetch artifact and verify checksum
      const artifactUrl = `${url}${encodeURIComponent(artifactName)}`;
      const artifactResponse = await fetch(artifactUrl);
      assert.equal(artifactResponse.status, 200, 'artifact should be served');
      const downloadedBuffer = Buffer.from(await artifactResponse.arrayBuffer());
      assert.equal(downloadedBuffer.length, artifactContent.length, 'downloaded size should match');

      // Verify the downloaded content matches the checksum in the manifest
      const downloadedSha512 = crypto.createHash('sha512').update(downloadedBuffer).digest('base64');
      assert.equal(downloadedSha512, expectedSha512, 'downloaded artifact checksum should match manifest');

      // Verify content integrity
      assert.deepEqual(downloadedBuffer, artifactContent, 'downloaded content should match original');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Test that simulates what electron-updater does when app-update.yml is present
test('generic provider feed: manifest URL construction matches electron-updater behavior', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-generic-feed-'));
  try {
    // Simulate a generic feed structure like the J2K private feed
    const version = '1.21.0-j2k.24';
    const artifactContent = Buffer.from('test-artifact');
    const artifactName = `OpenChamber-${version}-mac-arm64.zip`;
    fs.writeFileSync(path.join(root, artifactName), artifactContent);

    const sha512 = crypto.createHash('sha512').update(artifactContent).digest('base64');
    const manifest = [
      `version: ${version}`,
      'files:',
      `  - url: ${artifactName}`,
      `    sha512: ${sha512}`,
      `    size: ${artifactContent.length}`,
      `path: ${artifactName}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'latest-mac.yml'), manifest);

    const { server, url } = await createFixtureServer({ directory: root });
    try {
      // electron-updater with generic provider constructs URLs as: baseUrl + manifestName
      // then downloads artifacts relative to the manifest URL or using absolute paths
      const manifestUrl = `${url}latest-mac.yml`;
      const manifestRes = await fetch(manifestUrl);
      assert.equal(manifestRes.status, 200);

      // With relative artifact URLs in manifest, electron-updater resolves them
      // relative to the manifest location (baseUrl)
      const artifactUrl = new URL(artifactName, url).toString();
      const artifactRes = await fetch(artifactUrl);
      assert.equal(artifactRes.status, 200);
      assert.equal(
        crypto.createHash('sha512').update(Buffer.from(await artifactRes.arrayBuffer())).digest('base64'),
        sha512,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
