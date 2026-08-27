import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const tool = resolve('tools/channel-release/channel-release.mjs');
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const targetArgs = ['--platform', 'darwin', '--arch', 'arm64', '--node-abi', '127'];

test('verify-release accepts an exact, relocatable channel artifact set', () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-release-test-'));
  const packageRoot = join(root, 'packages', 'web');
  const output = join(root, 'output');
  try {
    mkdirSync(output, { recursive: true });
    for (const directory of ['bin', 'server', 'dist', 'public']) mkdirSync(join(packageRoot, directory), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/web',
      version: '1.21.0',
      bin: { openchamber: './bin/cli.js' },
    }));
    writeFileSync(join(packageRoot, 'bin/cli.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(packageRoot, 'server/index.js'), 'export {};\n');
    writeFileSync(join(packageRoot, 'dist/index.html'), '<!doctype html>\n');
    writeFileSync(join(packageRoot, 'README.md'), '# Fixture\n');
    const identityArgs = [
      '--base-version', '1.21.0',
      '--revision', '1',
      '--upstream-tag', 'v1.21.0',
      '--source-commit', sourceCommit,
      ...targetArgs,
    ];
    execFileSync(process.execPath, [tool, 'stage-version', ...identityArgs], { cwd: root });
    execFileSync(process.execPath, [tool, 'pack',
      ...identityArgs,
      '--output-dir', output,
    ], { cwd: root });

    const targetTampered = JSON.parse(readFileSync(join(output, 'channel.json'), 'utf8'));
    targetTampered.platform = 'linux';
    writeFileSync(join(output, 'channel.json'), JSON.stringify(targetTampered));
    const targetRejected = spawnSync(process.execPath, [tool, 'verify-release',
      ...identityArgs,
      '--output-dir', output,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(targetRejected.status, 0);
    assert.match(targetRejected.stderr, /platform does not match/);

    targetTampered.platform = 'darwin';
    writeFileSync(join(output, 'channel.json'), JSON.stringify(targetTampered));
    const tampered = JSON.parse(readFileSync(join(output, 'channel.json'), 'utf8'));
    tampered.releaseTag = 'v1.21.0-j2k.2';
    writeFileSync(join(output, 'channel.json'), JSON.stringify(tampered));
    const rejected = spawnSync(process.execPath, [tool, 'verify-release',
      ...identityArgs,
      '--output-dir', output,
    ], { cwd: root, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /releaseTag does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts canonical semver boundaries and rejects noncanonical identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-version-test-'));
  const packageRoot = join(root, 'packages', 'web');
  try {
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '0.0.0' }));
    const accepted = spawnSync(process.execPath, [tool, 'stage-version',
      '--base-version', '0.0.0',
      '--revision', String(Number.MAX_SAFE_INTEGER),
      '--upstream-tag', 'v0.0.0',
      '--source-commit', sourceCommit,
      ...targetArgs,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version, `0.0.0-j2k.${Number.MAX_SAFE_INTEGER}`);

    for (const [baseVersion, revision, message] of [
      ['01.2.3', '1', 'base'],
      ['1.02.3', '1', 'base'],
      ['1.2.03', '1', 'base'],
      ['1.2.3', '0', 'revision'],
      ['1.2.3', '01', 'revision'],
      ['1.2.3', String(Number.MAX_SAFE_INTEGER + 1), 'revision'],
    ]) {
      const rejected = spawnSync(process.execPath, [tool, 'stage-version',
        '--base-version', baseVersion,
        '--revision', revision,
        '--upstream-tag', `v${baseVersion}`,
        '--source-commit', sourceCommit,
        ...targetArgs,
      ], { cwd: root, encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, new RegExp(message));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unknown and duplicate command options', () => {
  const common = [
    '--base-version', '1.21.0',
    '--revision', '1',
    '--upstream-tag', 'v1.21.0',
    '--source-commit', sourceCommit,
    ...targetArgs,
  ];
  for (const extra of [
    ['--channel-repository', 'jameskorzekwa/openchamber'],
    ['--revision', '2'],
  ]) {
    const rejected = spawnSync(process.execPath, [tool, 'stage-version', ...common, ...extra], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unknown option|Duplicate option/);
  }
});
