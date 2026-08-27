import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const release = readFileSync('.github/workflows/release.yml', 'utf8');
const sync = readFileSync('.github/workflows/sync-upstream.yml', 'utf8');
const validate = readFileSync('.github/workflows/validate.yml', 'utf8');
const docs = readFileSync('docs/CI_RELEASE_CHANNEL.md', 'utf8');

test('release supports exact-SHA j2k/current and upstream release branches without push recursion', () => {
  assert.match(release, /head_branch == 'j2k\/current'/);
  assert.match(release, /startsWith\(github\.event\.workflow_run\.head_branch, 'j2k\/v'\)/);
  assert.doesNotMatch(release, /^\s+push:\s*$/m);
  assert.match(release, /source_commit.*WORKFLOW_HEAD_SHA|workflow_sha.*WORKFLOW_HEAD_SHA/s);
  assert.match(release, /matching_tag/);
});

test('release publication is resumable and keeps candidate code outside the token step', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  const tokenStep = publish.slice(publish.indexOf('GH_TOKEN:'));
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(publish, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-release/);
  assert.doesNotMatch(tokenStep, /tools\/channel-release/);
  assert.match(tokenStep, /-F draft=true/);
  assert.match(tokenStep, /cmp -s/);
  assert.match(tokenStep, /--force-with-lease=refs\/heads\/j2k\/current:/);
  assert.match(release, /persist-credentials: false/);
  assert.match(release, /runs-on: macos-15/);
  assert.match(release, /node_abi="\$\(node -p 'process\.versions\.modules'\)"/);
  assert.match(release, /--platform "\$TARGET_PLATFORM"/);
  assert.match(release, /--arch "\$TARGET_ARCH"/);
  assert.match(release, /--node-abi "\$TARGET_NODE_ABI"/);
  assert.doesNotMatch(release, /npm pack/);
  assert.match(validate, /channel-release\.mjs pack-package/);
});

test('release smoke uses the strict channel and stage-version has no misplaced channel option', () => {
  const stage = release.slice(release.indexOf('node tools/channel-release/channel-release.mjs stage-version'), release.indexOf('bun run build'));
  const smoke = release.slice(release.indexOf('node tools/channel-release/smoke-installed-package.mjs'), release.indexOf('      - name: Upload immutable release candidates'));
  assert.doesNotMatch(stage, /channel-repository/);
  assert.match(smoke, /--channel-repository "jameskorzekwa\/openchamber"/);
});

test('manual dispatch and the privileged job require the trusted j2k/current workflow definition', () => {
  const metadata = release.slice(release.indexOf('  metadata:'), release.indexOf('  validate-release:'));
  const publish = release.slice(release.indexOf('  publish:'));
  const trustedWorkflow = /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/release\.yml@refs\/heads\/j2k\/current', github\.repository\)/;
  assert.match(metadata, /github\.ref == 'refs\/heads\/j2k\/current'/);
  assert.match(metadata, trustedWorkflow);
  assert.match(publish, /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/j2k\/current'/);
  assert.match(publish, trustedWorkflow);
  assert.ok(publish.match(trustedWorkflow).index < publish.indexOf('contents: write'));
});

test('publication leases a no-op source update and rechecks it before publishing', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(publish, /source_refspec="refs\/remotes\/origin\/source:refs\/heads\/\$SOURCE_REF"/);
  const lease = /--force-with-lease=refs\/heads\/\$SOURCE_REF:\$SOURCE_COMMIT/g;
  assert.equal([...publish.matchAll(lease)].length, 2);
  assert.ok(publish.lastIndexOf('--force-with-lease=refs/heads/$SOURCE_REF:$SOURCE_COMMIT') < publish.indexOf('-F draft=false'));
});

test('git rejects a no-op source update when its exact lease is stale or deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'channel-source-lease-'));
  const remote = join(root, 'remote.git');
  const writer = join(root, 'writer');
  const publisher = join(root, 'publisher');
  const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch=source', writer], { stdio: 'ignore' });
    git(writer, ['config', 'user.name', 'test']);
    git(writer, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(writer, 'file'), 'a\n');
    git(writer, ['add', 'file']);
    git(writer, ['commit', '-m', 'a']);
    const validated = git(writer, ['rev-parse', 'HEAD']);
    git(writer, ['remote', 'add', 'origin', remote]);
    git(writer, ['push', '--set-upstream', 'origin', 'source']);

    execFileSync('git', ['init', publisher], { stdio: 'ignore' });
    git(publisher, ['remote', 'add', 'origin', remote]);
    git(publisher, ['fetch', '--no-tags', 'origin', '+refs/heads/source:refs/remotes/origin/source']);
    const leasedPush = [
      '-C', publisher, 'push', '--atomic',
      `--force-with-lease=refs/heads/source:${validated}`,
      'origin', 'refs/remotes/origin/source:refs/heads/source',
    ];
    execFileSync('git', leasedPush, { stdio: 'ignore' });

    writeFileSync(join(writer, 'file'), 'b\n');
    git(writer, ['commit', '-am', 'b']);
    const moved = git(writer, ['rev-parse', 'HEAD']);
    git(writer, ['push', 'origin', 'source']);
    assert.notEqual(spawnSync('git', leasedPush, { stdio: 'ignore' }).status, 0);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/source'], { encoding: 'utf8' }).trim(), moved);

    git(writer, ['push', 'origin', ':refs/heads/source']);
    assert.notEqual(spawnSync('git', leasedPush, { stdio: 'ignore' }).status, 0);
    assert.notEqual(spawnSync('git', ['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/source']).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed release-branch validation is deduplicated and safely redispatched', () => {
  assert.match(validate, /Validation failed: \$BRANCH/);
  assert.match(validate, /--state all/);
  assert.match(validate, /gh issue edit/);
  assert.match(sync, /run_state.*active/s);
  assert.match(sync, /run_state.*success/s);
  assert.match(sync, /Redispatching validation for stranded branch/);
});

test('bootstrap documentation points j2k/current at the committed Phase 2 tip', () => {
  assert.match(docs, /committed Phase 2 tip/);
  assert.doesNotMatch(docs, /create `j2k\/current` at the approved Phase\s+1/);
});
