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

test('packs and verifies the exact ordered schema-2 web release contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-web-release-test-'));
  const packageRoot = join(root, 'packages', 'web');
  const darwinOutput = join(root, 'darwin');
  const linuxOutput = join(root, 'linux');
  const releaseOutput = join(root, 'release');
  const identityArgs = [
    '--base-version', '1.21.0',
    '--revision', '7',
    '--upstream-tag', 'v1.21.0',
    '--source-commit', sourceCommit,
  ];
  try {
    for (const directory of ['bin', 'server', 'dist', 'public']) mkdirSync(join(packageRoot, directory), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@openchamber/web',
      version: '1.21.0-j2k.7',
      bin: { openchamber: './bin/cli.js' },
    }));
    writeFileSync(join(packageRoot, 'bin/cli.js'), '#!/usr/bin/env node\n');
    writeFileSync(join(packageRoot, 'server/index.js'), 'export {};\n');
    writeFileSync(join(packageRoot, 'dist/index.html'), '<!doctype html>\n');
    writeFileSync(join(packageRoot, 'README.md'), '# Fixture\n');
    for (const [output, platform, arch] of [
      [darwinOutput, 'darwin', 'arm64'],
      [linuxOutput, 'linux', 'x64'],
    ]) {
      const archive = `openchamber-web-1.21.0-j2k.7-${platform}-${arch}-abi127.tgz`;
      execFileSync(process.execPath, [tool, 'pack-package',
        '--version', '1.21.0-j2k.7',
        '--source-commit', sourceCommit,
        '--platform', platform,
        '--arch', arch,
        '--node-abi', '127',
        '--archive-name', archive,
        '--output-dir', output,
      ], { cwd: root });
      mkdirSync(releaseOutput, { recursive: true });
      writeFileSync(join(releaseOutput, archive), readFileSync(join(output, archive)));
    }
    execFileSync(process.execPath, [tool, 'assemble-bundle',
      ...identityArgs,
      '--output-dir', releaseOutput,
    ], { cwd: root });

    const manifest = JSON.parse(readFileSync(join(releaseOutput, 'channel.json'), 'utf8'));
    assert.equal(manifest.schema, 2);
    assert.equal(manifest.releaseTag, 'web-v1.21.0-j2k.7');
    assert.deepEqual(manifest.artifacts.map(({ platform, arch, nodeAbi }) => ({ platform, arch, nodeAbi })), [
      { platform: 'darwin', arch: 'arm64', nodeAbi: '127' },
      { platform: 'linux', arch: 'x64', nodeAbi: '127' },
    ]);
    const checksumLines = readFileSync(join(releaseOutput, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    assert.match(checksumLines[0], /darwin-arm64-abi127\.tgz$/);
    assert.match(checksumLines[1], /linux-x64-abi127\.tgz$/);

    const canonicalManifest = readFileSync(join(releaseOutput, 'channel.json'), 'utf8');
    const canonicalChecksums = readFileSync(join(releaseOutput, 'SHA256SUMS'), 'utf8');
    const reordered = { baseVersion: manifest.baseVersion, schema: manifest.schema, ...manifest };
    writeFileSync(join(releaseOutput, 'channel.json'), JSON.stringify(reordered));
    const verify = () => spawnSync(process.execPath, [tool, 'verify-bundle', ...identityArgs, '--output-dir', releaseOutput], { cwd: root, encoding: 'utf8' });
    let rejected = verify();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /keys or key order differ/);

    writeFileSync(join(releaseOutput, 'channel.json'), canonicalManifest);
    const wrongTarget = JSON.parse(canonicalManifest);
    wrongTarget.artifacts.reverse();
    writeFileSync(join(releaseOutput, 'channel.json'), JSON.stringify(wrongTarget));
    rejected = verify();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must target darwin\/arm64\/ABI-127/);

    writeFileSync(join(releaseOutput, 'channel.json'), canonicalManifest);
    writeFileSync(join(releaseOutput, 'SHA256SUMS'), `${checksumLines.reverse().join('\n')}\n`);
    rejected = verify();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ordered web artifact checksums/);
    writeFileSync(join(releaseOutput, 'SHA256SUMS'), canonicalChecksums);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema-1 release rejects targets outside the canonical Darwin ABI-127 contract', () => {
  const rejected = spawnSync(process.execPath, [tool, 'verify-release',
    '--base-version', '1.21.0',
    '--revision', '1',
    '--upstream-tag', 'v1.21.0',
    '--source-commit', sourceCommit,
    '--platform', 'linux',
    '--arch', 'x64',
    '--node-abi', '127',
    '--output-dir', '/missing',
  ], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Schema-1 release must target darwin\/arm64\/ABI-127/);
});
