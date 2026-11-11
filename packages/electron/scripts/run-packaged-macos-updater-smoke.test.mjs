import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runMacUpdaterSmokeHarness } from './run-packaged-macos-updater-smoke.mjs';

const createFixture = () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-macos-updater-cleanup-'));
  const root = path.join(parent, 'run');
  const appPath = path.join(parent, 'OpenChamber.app');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'OpenChamber');
  const nextZip = path.join(parent, 'OpenChamber-next.zip');
  const outputPath = path.join(parent, 'evidence.json');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture');
  fs.writeFileSync(nextZip, 'zip');
  const input = {
    appPath,
    nextZip,
    nextVersion: '1.21.0-j2k.30',
    sourceRevision: 'a'.repeat(40),
    outputPath,
  };
  const createTemporaryRoot = () => {
    fs.mkdirSync(root);
    return root;
  };
  return { createTemporaryRoot, input, parent, root };
};

const assertHarnessRejectsAndRemovesRoot = async ({ fixture, expected, operations }) => {
  try {
    await assert.rejects(
      runMacUpdaterSmokeHarness({
        ...fixture.input,
        operations: { createTemporaryRoot: fixture.createTemporaryRoot, ...operations },
      }),
      expected,
    );
    assert.equal(fs.existsSync(fixture.root), false);
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
};

test('removes temporary state when packaged app validation fails', async () => {
  const fixture = createFixture();
  fs.rmSync(fixture.input.appPath, { recursive: true });
  await assertHarnessRejectsAndRemovesRoot({ fixture, expected: /ENOENT/, operations: {} });
});

test('removes partial feed state when fixture staging fails', async () => {
  const fixture = createFixture();
  await assertHarnessRejectsAndRemovesRoot({
    fixture,
    expected: /fixture staging failed/,
    operations: {
      stageFixture: ({ directory }) => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'partial.zip'), 'partial');
        throw new Error('fixture staging failed');
      },
    },
  });
});

test('removes staged feed state when fixture server startup fails', async () => {
  const fixture = createFixture();
  await assertHarnessRejectsAndRemovesRoot({
    fixture,
    expected: /fixture listen failed/,
    operations: {
      stageFixture: ({ directory }) => {
        fs.mkdirSync(directory, { recursive: true });
        return { artifactPath: path.join(directory, 'next.zip'), checksum: 'checksum', size: 3 };
      },
      startFixtureServer: async () => { throw new Error('fixture listen failed'); },
    },
  });
});

const successfulOperations = (fixture, overrides = {}) => ({
  createTemporaryRoot: fixture.createTemporaryRoot,
  stageFixture: ({ directory }) => {
    fs.mkdirSync(directory, { recursive: true });
    const artifactPath = path.join(directory, 'next.zip');
    fs.writeFileSync(artifactPath, 'zip');
    return { artifactPath, checksum: 'checksum', size: 3 };
  },
  startFixtureServer: async () => ({
    requests: [
      { method: 'GET', path: '/latest-mac.yml', status: 200, bytes: 100 },
      { method: 'GET', path: '/next.zip', status: 200, bytes: 3 },
    ],
    server: {},
    url: 'http://127.0.0.1:49152/',
  }),
  executeChild: async ({ environment }) => {
    fs.writeFileSync(environment.OPENCHAMBER_UPDATER_SMOKE_EVIDENCE, JSON.stringify({
      discoveredVersion: fixture.input.nextVersion,
      downloadedSha512: 'checksum',
      downloadedBytes: 3,
    }));
  },
  ...overrides,
});

test('removes temporary state when fixture server shutdown fails', async () => {
  const fixture = createFixture();
  await assertHarnessRejectsAndRemovesRoot({
    fixture,
    expected: /fixture close failed/,
    operations: successfulOperations(fixture, {
      stopFixtureServer: async () => { throw new Error('fixture close failed'); },
    }),
  });
});

test('reports both the primary failure and fixture server shutdown failure', async () => {
  const fixture = createFixture();
  await assertHarnessRejectsAndRemovesRoot({
    fixture,
    expected: (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((entry) => entry.message), [
        'packaged child failed',
        'fixture close failed',
      ]);
      return true;
    },
    operations: successfulOperations(fixture, {
      executeChild: async () => { throw new Error('packaged child failed'); },
      stopFixtureServer: async () => { throw new Error('fixture close failed'); },
    }),
  });
});
