import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const release = readFileSync('.github/workflows/release.yml', 'utf8');
const docsSource = readFileSync('.github/workflows/docs-source.yml', 'utf8');
const sync = readFileSync('.github/workflows/sync-upstream.yml', 'utf8');
const validate = readFileSync('.github/workflows/validate.yml', 'utf8');
const docs = readFileSync('docs/CI_RELEASE_CHANNEL.md', 'utf8');

test('release triggers from validated candidate branches and j2k/current without push recursion', () => {
  assert.match(release, /startsWith\(github\.event\.workflow_run\.head_branch, 'j2k\/v'\)/);
  // The documented contract: an ordinary validated patch commit merged to
  // j2k/current releases too. Before this, a merged fix waited unreleased for
  // the next upstream tag, and the docs and the workflow disagreed.
  assert.match(release, /github\.event\.workflow_run\.head_branch == 'j2k\/current'/);
  assert.match(release, /"\$source_ref" != 'j2k\/current'/);
  assert.match(release, /git describe --tags --match 'v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*' --exclude '\*-j2k\.\*' --abbrev=0 "\$source_commit"/);
  assert.match(docs, /validated ordinary patch commit on long-lived `j2k\/current`/);
  assert.doesNotMatch(release, /^\s+push:\s*$/m);
  assert.match(release, /source_commit.*WORKFLOW_HEAD_SHA|workflow_sha.*WORKFLOW_HEAD_SHA/s);
  assert.match(release, /matching_tag/);
  assert.match(release, /git remote add upstream https:\/\/github\.com\/openchamber\/openchamber\.git/);
  assert.match(release, /git fetch upstream '\+refs\/tags\/v\*:refs\/tags\/v\*'/);
  assert.match(release, /github\.ref == 'refs\/heads\/j2k\/current'/);
});

test('release publication is resumable and keeps candidate code outside the token step', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  const tokenStep = publish.slice(publish.indexOf('GH_TOKEN:'));
  const trustedStep = publish.slice(0, publish.indexOf('GH_TOKEN:'));
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(trustedStep, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-release[\s\S]*--output-dir legacy-web-artifacts/);
  assert.match(trustedStep, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-bundle[\s\S]*--output-dir multi-web-artifacts/);
  assert.doesNotMatch(tokenStep, /tools\/channel-release/);
  assert.match(tokenStep, /-F draft=true/);
  assert.match(tokenStep, /cmp -s/);
  assert.match(tokenStep, /gh release upload "\$RELEASE_TAG"/);
  assert.match(tokenStep, /releases\?per_page=100/);
  assert.match(tokenStep, /releases\/\$release_id/);
  assert.match(tokenStep, /RELEASES_FILE=.*RELEASE_TAG=.*node/s);
  assert.doesNotMatch(tokenStep, /RESUME:/);
  assert.match(tokenStep, /current_j2k.*EXPECTED_J2K.*SOURCE_COMMIT/s);
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

test('release workflow run expressions stay below GitHub limits', () => {
  const jobs = YAML.parse(release).jobs ?? {};
  const publisherSteps = (jobs.publish?.steps ?? []).filter((step) => step.env?.GH_TOKEN);
  const oversized = [];
  for (const [jobName, job] of Object.entries(jobs)) {
    (job.steps ?? []).forEach((step, index) => {
      const script = String(step.run ?? '');
      if (script.length >= 20_000) {
        oversized.push(`${jobName} step ${index} (${step.name ?? 'unnamed'}): ${script.length}`);
      }
    });
  }
  assert.deepEqual(oversized, []);
  assert.equal(publisherSteps.length, 2);
  assert.match(publisherSteps[1].run, /repo="\$RUNNER_TEMP\/release-repository"/);
  assert.match(publisherSteps[1].run, /gh api --paginate .*releases\?per_page=100.*--slurp/);
  assert.match(publisherSteps[1].run, /release_json=.*RELEASES_FILE=.*RELEASE_TAG/s);
  assert.match(publisherSteps[1].run, /GitHub Release source identity differs/);
  assert.match(publisherSteps[1].run, /release_id=.*RELEASE_JSON/s);
});

test('release smoke uses the strict channel and stage-version has no misplaced channel option', () => {
  const stage = release.slice(release.indexOf('node tools/channel-release/channel-release.mjs stage-version'), release.indexOf('bun run build'));
  const smokeStep = release.slice(release.indexOf('      - name: Create and verify canonical stable release assets'), release.indexOf('      - name: Upload immutable canonical stable candidate'));
  const smoke = release.slice(release.indexOf('node tools/channel-release/smoke-installed-package.mjs'), release.indexOf('      - name: Upload immutable canonical stable candidate'));
  assert.doesNotMatch(stage, /channel-repository/);
  assert.match(smoke, /--channel-repository "jameskorzekwa\/openchamber"/);
  assert.match(smokeStep, /OPENCHAMBER_UPDATE_GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
});

test('native candidate jobs build and smoke exact Node 22 ABI 127 targets without write credentials', () => {
  const jobs = YAML.parse(release).jobs;
  const darwin = JSON.stringify(jobs['validate-release']);
  const linux = JSON.stringify(jobs['validate-release-linux']);
  const assembly = JSON.stringify(jobs['assemble-web-bundle']);
  assert.equal(jobs['validate-release']['runs-on'], 'macos-15');
  assert.equal(jobs['validate-release-linux']['runs-on'], 'ubuntu-latest');
  assert.deepEqual(jobs['validate-release'].permissions, { contents: 'read' });
  assert.deepEqual(jobs['validate-release-linux'].permissions, { contents: 'read' });
  assert.deepEqual(jobs['assemble-web-bundle'].permissions, { contents: 'read' });
  for (const candidate of [darwin, linux, assembly]) {
    assert.doesNotMatch(candidate, /contents:write|GH_TOKEN|--clobber/);
  }
  assert.match(darwin, /process\.platform.*darwin/);
  assert.match(darwin, /process\.arch.*arm64/);
  assert.match(darwin, /process\.versions\.modules.*127/);
  assert.match(darwin, /xcrun --find clang/);
  assert.match(darwin, /bun install --frozen-lockfile/);
  assert.match(darwin, /pack-package[\s\S]*--archive-name[\s\S]*darwin-arm64-abi127/);
  assert.equal((darwin.match(/smoke-installed-package\.mjs/g) ?? []).length, 2);
  assert.match(linux, /process\.platform.*linux/);
  assert.match(linux, /process\.arch.*x64/);
  assert.match(linux, /process\.versions\.modules.*127/);
  assert.match(linux, /command -v gcc/);
  assert.match(linux, /command -v g\+\+/);
  assert.match(linux, /bun install --frozen-lockfile/);
  assert.match(linux, /pack-package[\s\S]*--archive-name[\s\S]*linux-x64-abi127/);
  assert.equal((linux.match(/smoke-installed-package\.mjs/g) ?? []).length, 1);
  assert.match(assembly, /assemble-bundle/);
  assert.match(assembly, /channel-release-target-.*darwin-arm64-abi127/);
  assert.match(assembly, /channel-release-target-.*linux-x64-abi127/);
});

test('validation pins its native Linux target and exercises installed native dependencies', () => {
  const job = YAML.parse(validate).jobs.validate;
  const source = JSON.stringify(job);
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.match(source, /process\.platform.*linux/);
  assert.match(source, /process\.arch.*x64/);
  assert.match(source, /process\.versions\.modules.*127/);
  assert.match(source, /smoke-installed-package\.mjs/);
  assert.match(source, /--platform.*TARGET_PLATFORM/);
  assert.match(source, /--arch.*TARGET_ARCH/);
  assert.match(source, /--node-abi.*TARGET_NODE_ABI/);
});

test('companion release is immutable schema 2 while canonical stable stays exact schema 1', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(release, /web_release_tag="web-\$release_tag"/);
  assert.match(release, /git tag --list "web-v\$base_version-j2k\.\*"/);
  assert.match(release, /refs\+=\("refs\/tags\/\$WEB_RELEASE_TAG:refs\/tags\/\$WEB_RELEASE_TAG"\)/);
  assert.match(publish, /-f tag_name="\$WEB_RELEASE_TAG"[\s\S]*-F draft=true -F prerelease=true -f make_latest=false/);
  assert.match(publish, /`openchamber-web-\$\{process\.env\.VERSION\}-darwin-arm64-abi127\.tgz`/);
  assert.match(publish, /`openchamber-web-\$\{process\.env\.VERSION\}-linux-x64-abi127\.tgz`/);
  assert.match(publish, /Multi-target web release inventory differs/);
  assert.match(publish, /Existing multi-target web asset \$asset differs; refusing overwrite/);
  assert.match(publish, /Uploaded multi-target web asset \$asset differs from validated bytes/);
  assert.match(publish, /const expected = new Set\(\[`openchamber-web-\$\{process\.env\.VERSION\}\.tgz`, 'SHA256SUMS', 'channel\.json'\]\)/);
  assert.match(publish, /-f tag_name="\$RELEASE_TAG"[\s\S]*-F draft=true -F prerelease=false -f make_latest=true/);
  assert.doesNotMatch(publish, /gh release upload "\$RELEASE_TAG" "multi-web-artifacts/);
});

test('multi-target and desktop releases publish before the canonical stable release', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  const multi = publish.indexOf('-F draft=false -F prerelease=true -f make_latest=false');
  const desktop = publish.indexOf('-F draft=false -F prerelease=true -f make_latest=false', multi + 1);
  const stable = publish.indexOf('-F draft=false -F prerelease=false -f make_latest=true');
  assert.ok(multi >= 0 && desktop > multi && stable > desktop);
  assert.ok(publish.indexOf('Published multi-target web release identity differs') < stable);
  assert.ok(publish.indexOf('Published desktop release identity differs') < stable);
  assert.ok(publish.indexOf('refs/heads/desktop-channel:refs/heads/desktop-channel') < stable);
  assert.match(publish, /needs\.validate-release-linux\.result == 'success'/);
  assert.match(publish, /needs\.assemble-web-bundle\.result == 'success'/);
  assert.match(publish, /needs\.build-desktop\.result == 'success'/);
});

test('docs source cannot append assets to validated j2k channel releases', () => {
  const job = docsSource.slice(docsSource.indexOf('  validate-and-package:'));
  assert.match(job, /github\.event_name != 'release' \|\| !contains\(github\.event\.release\.tag_name, '-j2k\.'\)/);
  assert.match(job, /github\.event_name != 'workflow_dispatch' \|\| !contains\(inputs\.release_tag, '-j2k\.'\)/);
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

test('publication leases source ref atomically with j2k/current in a single push', () => {
  const publish = release.slice(release.indexOf('  publish:'));
  assert.match(publish, /source_refspec="refs\/remotes\/origin\/source:refs\/heads\/\$SOURCE_REF"/);
  assert.match(publish, /push_options=\(--atomic "--force-with-lease=refs\/heads\/\$SOURCE_REF:\$SOURCE_COMMIT"\)/);
  assert.match(publish, /push_options\+=\("--force-with-lease=refs\/heads\/j2k\/current:/);
  assert.match(publish, /refs\+=\("refs\/tags\/\$WEB_RELEASE_TAG:refs\/tags\/\$WEB_RELEASE_TAG"\)/);
  assert.match(publish, /git -C "\$repo" push "\$\{push_options\[@\]\}" origin "\$\{refs\[@\]\}"/);
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

test('failed release-branch validation defers to recovery workflow and sync safely redispatches', () => {
  assert.match(validate, /converting it to a failure for the trusted workflow-run recovery handler/);
  assert.match(validate, /report-release-branch-result/);
  assert.match(validate, /startsWith\(github\.ref_name, 'j2k\/v'\)/);
  assert.match(sync, /run_state.*active/s);
  assert.match(sync, /run_state.*success/s);
  assert.match(sync, /Redispatching validation for stranded branch/);
});

test('bootstrap documentation points j2k/current at the committed Phase 2 tip', () => {
  assert.match(docs, /committed Phase 2 tip/);
  assert.doesNotMatch(docs, /create `j2k\/current` at the approved Phase\s+1/);
});
