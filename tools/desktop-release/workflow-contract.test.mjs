import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const desktopWorkflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const syncWorkflow = readFileSync(new URL('../../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8');
const recoveryWorkflow = readFileSync(new URL('../../.github/workflows/recover-upstream-release.yml', import.meta.url), 'utf8');
const validateWorkflow = readFileSync(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
const reviewWorkflow = readFileSync(new URL('../../.github/workflows/oc-review.yml', import.meta.url), 'utf8');
const macVerifier = readFileSync(new URL('./verify-macos-app.mjs', import.meta.url), 'utf8');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function recoveryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'origin');
  git(root, 'init', '--initial-branch=main', repo);
  git(repo, 'config', 'user.name', 'Workflow test');
  git(repo, 'config', 'user.email', 'workflow@example.invalid');
  git(repo, 'commit', '--allow-empty', '-m', 'Previous upstream');
  git(repo, 'tag', 'v2.0.0');
  git(repo, 'switch', '-c', 'j2k/current');
  git(repo, 'commit', '--allow-empty', '-m', 'Fork patch');
  const series = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'New upstream');
  git(repo, 'tag', 'v2.1.0');
  const upstream = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', 'j2k/v2.1.0', series);
  return { root, repo, series, upstream };
}

test('existing sync candidates fail blocked or retain exact-SHA validation behavior', (t) => {
  const { root, repo, series, upstream } = recoveryFixture(t);
  const checkout = join(root, 'checkout');
  git(root, 'clone', repo, checkout);
  git(checkout, 'update-ref', 'refs/remotes/upstream/main', upstream);
  const script = YAML.parse(syncWorkflow).jobs.sync.steps.find((step) => step.id === 'rebase').run;
  // Execute the real selection/ancestry/redispatch path, stopping before new
  // candidate creation. The origin is a local fixture; gh only serves run data.
  const end = script.indexOf('git config user.name');
  assert.ok(end > 0);
  const excerpt = script.slice(0, end).replaceAll('${{ github.repository }}', 'fixture/repo');
  const output = join(root, 'output');
  const ghCalls = join(root, 'gh-calls');
  function run(runs) {
    writeFileSync(output, '');
    writeFileSync(ghCalls, '');
    const result = spawnSync('bash', {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, UPSTREAM_SYNC_TOKEN: 'fixture', GITHUB_OUTPUT: output, GH_CALLS: ghCalls, FIXTURE_RUNS: JSON.stringify(runs) },
      input: `gh() { printf '%s\\n' "$*" >> "$GH_CALLS"; printf '%s' "$FIXTURE_RUNS"; }\n${excerpt}`,
    });
    return { ...result, output: readFileSync(output, 'utf8'), calls: readFileSync(ghCalls, 'utf8') };
  }
  const blocked = run([]);
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /::error::.*blocked.*j2k\/v2\.1\.0.*v2\.1\.0/);
  assert.ok(blocked.stderr.includes(series));
  assert.equal(blocked.output, '');
  assert.equal(blocked.calls, '');
  assert.equal(git(repo, 'rev-parse', 'j2k/v2.1.0'), series);
  assert.equal(git(repo, 'rev-parse', 'j2k/current'), series);

  git(repo, 'branch', '-f', 'j2k/v2.1.0', upstream);
  for (const runInfo of [
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    { status: 'completed', conclusion: 'success' },
  ]) {
    const result = run([{ headSha: upstream, ...runInfo }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'changed=false\n');
  }
  for (const runs of [
    [],
    [{ headSha: upstream, status: 'completed', conclusion: 'failure' }],
    [{ headSha: upstream, status: 'completed', conclusion: 'cancelled' }],
    [{ headSha: series, status: 'completed', conclusion: 'success' }],
  ]) {
    const result = run(runs);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, 'dispatch=true\nbranch=j2k/v2.1.0\n');
  }
});

test('recovery reports can describe the previous base beyond the checkout tip', (t) => {
  const { root, repo, series } = recoveryFixture(t);
  const report = YAML.parse(recoveryWorkflow).jobs.report;
  const checkout = report.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['fetch-depth'], 0);
  const validationReport = YAML.parse(validateWorkflow).jobs['report-release-branch-result'];
  assert.equal(validationReport.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
  const script = report.steps.find((step) => step.run).run;
  const start = script.indexOf('series_commit=');
  const end = script.indexOf('jobs=');
  assert.ok(start >= 0 && end > start);
  const excerpt = `set -euo pipefail\n${script.slice(start, end)}\nprintf '%s\\n' "$previous_base"`;
  function describe(cwd) {
    return spawnSync('bash', {
      cwd, input: excerpt, encoding: 'utf8',
      env: { ...process.env, SERIES_COMMIT: series, PREVIOUS_BASE: '' },
    });
  }
  const shallow = join(root, 'shallow');
  git(root, 'clone', '--depth=1', '--branch=j2k/current', pathToFileURL(repo).href, shallow);
  git(shallow, 'fetch', '--tags', 'origin');
  assert.notEqual(describe(shallow).status, 0, 'Fetching tags alone must reproduce the shallow-history failure');
  const full = join(root, 'full');
  git(root, 'clone', '--branch=j2k/current', pathToFileURL(repo).href, full);
  const result = describe(full);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v2.0.0\n');
});

test('fork PR checks use available hosted runners and retain all four validation jobs', () => {
  const jobs = YAML.parse(reviewWorkflow).jobs;
  const expectedCommands = {
    'type-check': ['bun run type-check'],
    lint: ['bun run lint', 'bun run changelog:check'],
    tests: ['bun run test', 'bun run test:architecture', 'bun run test:updater'],
    build: ['bun run --cwd packages/web build', 'bun run --cwd packages/vscode build', 'bun run --cwd packages/mobile build:assets'],
  };
  assert.deepEqual(Object.keys(jobs).sort(), Object.keys(expectedCommands).sort());
  for (const [name, required] of Object.entries(expectedCommands)) {
    const job = jobs[name];
    assert.equal(job['runs-on'], 'ubuntu-latest', `${name} must run without upstream-only runner registration`);
    assert.equal(job.if, undefined);
    assert.equal(job.needs, undefined);
    assert.notEqual(job['continue-on-error'], true);
    const commands = job.steps.flatMap((step) => (step.run ?? '').split('\n').map((line) => line.trim()));
    for (const command of ['bun install --frozen-lockfile', ...required]) {
      assert.ok(commands.includes(command), `${name} must retain ${command}`);
    }
    for (const step of job.steps) {
      assert.equal(step.if, undefined);
      assert.notEqual(step['continue-on-error'], true);
    }
  }
});

test('validation retains root suites without the obsolete v1 fixture', () => {
  for (const source of [validateWorkflow, reviewWorkflow, releaseWorkflow]) {
    const jobs = Object.values(YAML.parse(source).jobs);
    const steps = jobs.flatMap((job) => job.steps ?? []);
    const commands = steps.flatMap((step) => (step.run ?? '').split('\n').map((line) => line.trim()));
    assert.ok(commands.includes('bun run test'));
    assert.ok(commands.includes('bun run type-check'));
    assert.ok(commands.includes('bun run lint'));
    assert.doesNotMatch(source, /1\.18\.29|OPENCODE_REAL_TEST|Prepare exact OpenCode restart-test binary/);
  }
});

test('desktop release is a build-only component for an exact candidate', () => {
  assert.match(desktopWorkflow, /workflow_call:/);
  assert.doesNotMatch(desktopWorkflow, /workflow_dispatch:/);
  assert.match(desktopWorkflow, /source_sha must be an exact lowercase 40-character commit/);
  // The workflow accepts both j2k/vX.Y.Z candidate branches and j2k/current.
  assert.match(desktopWorkflow, /source_ref must be j2k\/vX\.Y\.Z or j2k\/current/);
  assert.match(desktopWorkflow, /source_commit.*INPUT_SOURCE_SHA/);
  assert.doesNotMatch(desktopWorkflow, /^  publish:/m);
  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/desktop-release\.yml/);
  assert.match(releaseWorkflow, /source_sha: \$\{\{ needs\.metadata\.outputs\.source_commit \}\}/);
});

test('private signing is fingerprint-pinned and never requests Apple notarization', () => {
  assert.match(desktopWorkflow, /MACOS_PRIVATE_CERTIFICATE_SHA256/);
  assert.match(desktopWorkflow, /actual_sha256.*expected_sha256/);
  assert.match(desktopWorkflow, /sudo security add-trusted-cert -d -r trustRoot -p codeSign -k \/Library\/Keychains\/System\.keychain "\$leaf"/);
  assert.match(desktopWorkflow, /security find-identity -v -p codesigning/);
  assert.match(desktopWorkflow, /const \{ signAsync \} = createRequire\(appBuilderLib\)\('@electron\/osx-sign'\)/);
  assert.match(desktopWorkflow, /--certificate-sha256/);
  assert.doesNotMatch(desktopWorkflow, /APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|notarytool|stapler staple/);
  assert.match(macVerifier, /`--extract-certificates=\$\{prefix\}`/);
  assert.doesNotMatch(macVerifier, /'--extract-certificates', prefix/);
  const cleanup = desktopWorkflow.slice(
    desktopWorkflow.indexOf('- name: Remove temporary signing material'),
    desktopWorkflow.indexOf('  packaged-updater-smoke:'),
  );
  assert.match(cleanup, /if \[\[ -e "\$keychain" \]\]; then\n\s+security delete-keychain "\$keychain"/);
  assert.doesNotMatch(cleanup, /security delete-keychain .*\|\|/);
});

test('candidate build has no write token and publisher runs trusted verifier only', () => {
  const build = desktopWorkflow.slice(desktopWorkflow.indexOf('  candidate-build:'), desktopWorkflow.indexOf('  sign-and-verify:'));
  const signer = desktopWorkflow.slice(desktopWorkflow.indexOf('  sign-and-verify:'));
  const publish = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:'));
  assert.match(build, /permissions:\n      contents: read/);
  assert.doesNotMatch(build, /contents: write/);
  assert.doesNotMatch(build, /MACOS_PRIVATE_CERTIFICATE|CSC_NAME|CSC_KEYCHAIN/);
  assert.match(signer, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(signer, /environment: j2k-release/);
  assert.match(signer, /Unsigned candidate acquired an identity signature before the trusted signing job/);
  assert.match(build, /--unsigned true/);
  assert.match(signer, /--skip-cli-execution true/);
  assert.match(macVerifier, /if \(!skipCliExecution\)/);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(publish, /needs\.metadata\.result == 'success'/);
  assert.match(publish, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/release\.yml@refs\/heads\/j2k\/current'/);
  assert.match(publish, /node trusted\/tools\/desktop-release\/desktop-release\.mjs verify-release/);
  assert.match(publish, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-release/);
  assert.match(publish, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-bundle/);
  assert.ok(publish.indexOf('verify-release') < publish.indexOf('GH_TOKEN:'));
  assert.ok(publish.indexOf('verify-bundle') < publish.indexOf('GH_TOKEN:'));
  assert.doesNotMatch(publish, /node (?:web|desktop)-artifacts\//);
  assert.match(signer, /require\.resolve\(`electron\/package\.json`, \{ paths: \[`\.\/trusted\/packages\/electron`\] \}\)/);
  assert.doesNotMatch(signer, /require\(`\.\/node_modules\/electron\/package\.json`\)/);
});

test('publication waits for strict final-app verification and a real packaged updater download', () => {
  const signer = desktopWorkflow.slice(
    desktopWorkflow.indexOf('  sign-and-verify:'),
    desktopWorkflow.indexOf('  packaged-updater-smoke:'),
  );
  const smoke = desktopWorkflow.slice(desktopWorkflow.indexOf('  packaged-updater-smoke:'));
  assert.match(signer, /--artifact-label 'final signed app'/);
  assert.match(signer, /--artifact-label 'final ZIP app'/);
  assert.match(signer, /--artifact-label 'final DMG app'/);
  assert.match(smoke, /needs:\n      - metadata\n      - sign-and-verify/);
  assert.match(smoke, /permissions:\n      contents: read/);
  assert.doesNotMatch(smoke, /environment: j2k-release|MACOS_PRIVATE_CERTIFICATE|contents: write/);
  assert.match(smoke, /run-packaged-macos-updater-smoke\.mjs/);
  assert.match(smoke, /--next-zip "\$zip" --next-version "\$version"/);
  assert.match(smoke, /desktop-updater-smoke-evidence/);
  assert.match(releaseWorkflow, /needs\.build-desktop\.result == 'success'/);
});

test('one publisher gates publication on both web bundles and signed desktop assets', () => {
  const publish = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:'));
  assert.match(releaseWorkflow, /needs\.build-desktop\.result == 'success'/);
  assert.match(publish, /desktop-artifacts/);
  assert.match(publish, /legacy-web-artifacts/);
  assert.match(publish, /multi-web-artifacts/);
  assert.match(publish, /gh api --paginate .*releases\?per_page=100.*--slurp/);
  assert.match(publish, /-F draft=true -F prerelease=true -f make_latest=false/);
  assert.match(publish, /-F draft=true -F prerelease=false/);
  assert.match(publish, /Existing desktop asset \$asset differs; refusing overwrite/);
  assert.match(publish, /Existing release asset \$asset differs; refusing to overwrite/);
  assert.match(publish, /Existing multi-target web asset \$asset differs; refusing overwrite/);
  assert.doesNotMatch(publish, /--clobber/);
  const firstPrerelease = publish.indexOf('-F draft=false -F prerelease=true');
  const secondPrerelease = publish.indexOf('-F draft=false -F prerelease=true', firstPrerelease + 1);
  const stable = publish.indexOf('-F draft=false -F prerelease=false');
  assert.ok(firstPrerelease >= 0 && secondPrerelease > firstPrerelease && stable > secondPrerelease);
});

test('desktop-channel update uses the captured branch lease and contains one manifest', () => {
  assert.match(releaseWorkflow, /EXPECTED_DESKTOP_CHANNEL: \$\{\{ needs\.metadata\.outputs\.desktop_channel_commit \}\}/);
  assert.match(releaseWorkflow, /test "\$current_channel" = "\$EXPECTED_DESKTOP_CHANNEL"/);
  assert.match(releaseWorkflow, /refs\/heads\/desktop-channel:refs\/remotes\/origin\/desktop-channel/);
  assert.match(releaseWorkflow, /100644 blob %s\\tlatest-mac\.yml/);
  assert.match(releaseWorkflow, /--force-with-lease=refs\/heads\/desktop-channel:\$EXPECTED_DESKTOP_CHANNEL/);
});

test('unified workflow preserves the web release exact-three stable contract', () => {
  assert.match(releaseWorkflow, /const expected = new Set\(\[`openchamber-web-\$\{process\.env\.VERSION\}\.tgz`, 'SHA256SUMS', 'channel\.json'\]\)/);
  assert.match(releaseWorkflow, /if \(release\.prerelease\) throw new Error\('Channel release cannot be a prerelease'\)/);
  assert.match(releaseWorkflow, /-F draft=false -F prerelease=false -f make_latest=true/);
  assert.match(releaseWorkflow, /-f tag_name="\$RELEASE_TAG"[\s\S]*-F draft=true -F prerelease=false -f make_latest=true/);
  assert.match(releaseWorkflow, /desktop-release\.json/);
});

test('desktop release remains exact-six and publishes before stable web', () => {
  const publish = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:'));
  assert.match(publish, /const expected = \[\s*`OpenChamber-\$\{process\.env\.VERSION\}-mac-arm64\.dmg`,\s*`OpenChamber-\$\{process\.env\.VERSION\}-mac-arm64\.zip`,\s*`OpenChamber-\$\{process\.env\.VERSION\}-mac-arm64\.zip\.blockmap`,\s*'latest-mac\.yml', 'SHA256SUMS', 'desktop-release\.json',/);
  const desktopPublish = publish.indexOf('releases/$desktop_release_id" \\\n              -F draft=false -F prerelease=true');
  const stablePublish = publish.indexOf('releases/$release_id" \\\n              -F draft=false -F prerelease=false');
  assert.ok(desktopPublish >= 0 && stablePublish > desktopPublish);
  assert.ok(publish.indexOf('refs/heads/desktop-channel:refs/heads/desktop-channel') < stablePublish);
  assert.match(desktopWorkflow, /run-packaged-macos-updater-smoke\.mjs/);
});

test('conflicts create OPM recovery without touching release refs', () => {
  assert.match(syncWorkflow, /UPSTREAM_SYNC_TOKEN/);
  assert.match(syncWorkflow, /push_release_ref/);
  assert.match(syncWorkflow, /upstream-recovery\.mjs/);
  assert.match(syncWorkflow, /--label opm:ready/);
  const conflictPath = syncWorkflow.slice(syncWorkflow.indexOf('if ! git rebase'), syncWorkflow.indexOf('push_release_ref "HEAD:refs/heads/$branch"'));
  assert.doesNotMatch(conflictPath, /refs\/heads\/j2k\/current|gh release|refs\/tags/);
  assert.match(conflictPath, /git\/refs/);
  assert.match(conflictPath, /ref="refs\/heads\/\$branch"/);
  assert.doesNotMatch(conflictPath, /push_release_ref/);
  assert.match(syncWorkflow, /steps\.rebase\.outputs\.dispatch == 'true'/);
});

test('semantic release failures use the same recovery contract', () => {
  assert.match(recoveryWorkflow, /workflows:\n      - J2K Validate\n      - J2K Release/);
  assert.match(recoveryWorkflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(recoveryWorkflow, /gh run download "\$FAILED_RUN_ID".*--name release-identity/);
  assert.match(releaseWorkflow, /patchSeriesSourceCommit: process\.env\.SERIES_COMMIT \|\| null/);
  assert.match(recoveryWorkflow, /patchSeriesSourceCommit \|\| ``/);
  assert.match(releaseWorkflow, /commit="\$\(git rev-parse refs\/remotes\/origin\/recovery-source\)"/);
  assert.match(recoveryWorkflow, /upstream-recovery\.mjs/);
  assert.match(recoveryWorkflow, /--label opm:ready/);
  assert.doesNotMatch(recoveryWorkflow, /contents: write/);
  assert.doesNotMatch(recoveryWorkflow, /UPSTREAM_SYNC_TOKEN/);
  assert.match(recoveryWorkflow, /issues: write/);
  assert.doesNotMatch(validateWorkflow, /upstream-recovery\.mjs/);
});

test('publication rechecks source leases and refuses branch rewinds', () => {
  const publish = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:'));
  assert.match(releaseWorkflow, /Refusing to rewind j2k\/current/);
  assert.match(releaseWorkflow, /desktop-v\*-j2k\.\*/);
  assert.match(releaseWorkflow, /web-v\*-j2k\.\*/);
  assert.match(releaseWorkflow, /same-base commit has no authoritative web or desktop release tag/);
  assert.match(publish, /Refusing to rewind desktop-channel/);
  assert.match(publish, /ls-remote origin "refs\/heads\/\$SOURCE_REF".*= "\$SOURCE_COMMIT"/);
  assert.match(publish, /ls-remote origin refs\/heads\/j2k\/current.*= "\$SOURCE_COMMIT"/);
  assert.match(publish, /permissions:\n      contents: write\n      issues: write/);
  assert.match(publish, /Uploaded web asset \$asset differs from validated bytes/);
  assert.match(publish, /Uploaded multi-target web asset \$asset differs from validated bytes/);
  assert.match(publish, /Uploaded desktop asset \$asset differs from validated bytes/);
  assert.match(publish, /test "\$final_web_tag" = "\$SOURCE_COMMIT"/);
  assert.match(publish, /test "\$final_desktop_tag" = "\$SOURCE_COMMIT"/);
});

test('all release secrets are protected by the trusted-branch environment', () => {
  assert.match(syncWorkflow, /environment: j2k-release/);
  assert.match(recoveryWorkflow, /environment: j2k-release/);
  assert.match(releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:')), /environment: j2k-release/);
  assert.doesNotMatch(releaseWorkflow, /secrets:\n      MACOS_PRIVATE_CERTIFICATE/);
  assert.doesNotMatch(recoveryWorkflow, /secrets\.UPSTREAM_SYNC_TOKEN/);
});

test('every workflow run block is parseable bash, including heredoc terminators', () => {
  // A `<<'NODE'` heredoc ends only at a `NODE` line in column 0 of the run
  // block. An indented terminator inside an if/subshell swallows the rest of
  // the script, and bash reports "unexpected end of file" at runtime; this
  // stopped the release metadata job before any release was cut.
  const workflows = [
    ['desktop-release.yml', desktopWorkflow],
    ['release.yml', releaseWorkflow],
    ['sync-upstream.yml', syncWorkflow],
    ['recover-upstream-release.yml', recoveryWorkflow],
    ['validate.yml', validateWorkflow],
    ['oc-review.yml', reviewWorkflow],
  ];
  const failures = [];
  for (const [name, source] of workflows) {
    const jobs = YAML.parse(source).jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      (job.steps ?? []).forEach((step, index) => {
        const script = String(step.run ?? '').replace(/\$\{\{[^}]*\}\}/g, 'expression');
        if (script === '') return;
        const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
        if (result.status !== 0) failures.push(`${name} ${jobName} step ${index} (${step.name ?? 'unnamed'}): ${result.stderr.trim()}`);
      });
    }
  }
  assert.deepEqual(failures, []);
});

test('rendered desktop smoke revisions execute as arithmetic', () => {
  const assignments = [];
  const jobs = YAML.parse(desktopWorkflow).jobs ?? {};
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      const script = String(step.run ?? '').replaceAll('${{ needs.metadata.outputs.revision }}', '27');
      for (const line of script.split('\n')) {
        if (line.trim().startsWith('smoke_revision=')) assignments.push(line.trim());
      }
    }
  }

  assert.equal(assignments.length, 4);
  const failures = assignments.flatMap((assignment) => {
    const script = `set -euo pipefail\nrevision=27\n${assignment}\ntest "$smoke_revision" = 26\n`;
    const result = spawnSync('bash', { input: script, encoding: 'utf8' });
    return result.status === 0 ? [] : [`${assignment}: ${result.stderr.trim()}`];
  });
  assert.deepEqual(failures, []);
});

// Regression tests for desktop metadata/source-resolution path
// These verify that desktop-release.yml correctly validates source_ref
// for both j2k/current and j2k/vX.Y.Z candidate branches.

test('desktop source validation accepts j2k/current as a valid source_ref', () => {
  // The desktop workflow must accept j2k/current alongside candidate branches.
  // The outer release.yml already derives base_version from git describe for
  // j2k/current, so the desktop workflow only needs to validate the format.
  assert.match(desktopWorkflow, /\$INPUT_SOURCE_REF" == 'j2k\/current'/);
  // For j2k/current, base_version is validated as SemVer without branch-name check.
  assert.match(desktopWorkflow, /base_version must be a SemVer triple/);
  // Both patterns are documented in the error message for invalid refs.
  assert.match(desktopWorkflow, /source_ref must be j2k\/vX\.Y\.Z or j2k\/current/);
});

test('desktop source validation accepts j2k/vX.Y.Z candidate branches', () => {
  // For candidate branches, the branch name must encode the base version.
  assert.match(desktopWorkflow, /\$INPUT_SOURCE_REF" =~ \^j2k\/v\[0-9\]\+/);
  assert.match(desktopWorkflow, /Candidate branch and base version differ/);
});

test('desktop source validation rejects invalid source refs', () => {
  // Arbitrary branch names are rejected.
  assert.match(desktopWorkflow, /source_ref must be j2k\/vX\.Y\.Z or j2k\/current/);
});

test('desktop source validation requires exact 40-character commit SHA', () => {
  // The source_sha is always validated regardless of source_ref type.
  assert.match(desktopWorkflow, /source_sha must be an exact lowercase 40-character commit/);
  assert.match(desktopWorkflow, /\$INPUT_SOURCE_SHA" =~ \^/);
});

test('desktop source validation detects source movement during workflow', () => {
  // If the branch moves after the caller captured the SHA, the build fails.
  assert.match(desktopWorkflow, /moved or does not resolve to requested SHA/);
  assert.match(desktopWorkflow, /\$source_commit" != "\$INPUT_SOURCE_SHA"/);
});

test('desktop release identity is consistent across source refs', () => {
  // Both j2k/current and candidate branches produce identical release identity
  // structure: base_version-j2k.revision and desktop-vbase_version-j2k.revision.
  assert.match(desktopWorkflow, /release_tag=desktop-v%s/);
  assert.match(desktopWorkflow, /version='\$\{\{ inputs\.base_version \}\}-j2k\.\$\{\{ inputs\.revision \}\}'/);
  // Package versions must match the requested base_version.
  assert.match(desktopWorkflow, /Electron base version.*differs from requested/);
});

test('outer release workflow correctly passes source_ref to desktop workflow', () => {
  // The release.yml passes the actual source_ref to desktop-release.yml.
  assert.match(releaseWorkflow, /source_ref: \$\{\{ needs\.metadata\.outputs\.source_ref \}\}/);
  // The outer workflow accepts both patterns.
  assert.match(releaseWorkflow, /Source ref must be j2k\/vX\.Y\.Z or j2k\/current/);
  // For j2k/current, base_version is derived from git describe.
  assert.match(releaseWorkflow, /series_base_tag.*git describe --tags --match/);
});
