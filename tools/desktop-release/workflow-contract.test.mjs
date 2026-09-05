import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

const desktopWorkflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const syncWorkflow = readFileSync(new URL('../../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8');
const recoveryWorkflow = readFileSync(new URL('../../.github/workflows/recover-upstream-release.yml', import.meta.url), 'utf8');
const validateWorkflow = readFileSync(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
const macVerifier = readFileSync(new URL('./verify-macos-app.mjs', import.meta.url), 'utf8');

test('desktop release is a build-only component for an exact candidate', () => {
  assert.match(desktopWorkflow, /workflow_call:/);
  assert.doesNotMatch(desktopWorkflow, /workflow_dispatch:/);
  assert.match(desktopWorkflow, /source_sha must be an exact lowercase 40-character commit/);
  assert.match(desktopWorkflow, /source_ref must be a candidate branch/);
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
  assert.match(desktopWorkflow, /import \{ signAsync \} from '@electron\/osx-sign'/);
  assert.match(desktopWorkflow, /--certificate-sha256/);
  assert.doesNotMatch(desktopWorkflow, /APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|notarytool|stapler staple/);
  assert.match(macVerifier, /`--extract-certificates=\$\{prefix\}`/);
  assert.doesNotMatch(macVerifier, /'--extract-certificates', prefix/);
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
  assert.match(signer, /Unsigned candidate acquired a signature before the trusted signing job/);
  assert.match(build, /--unsigned true/);
  assert.match(signer, /--skip-cli-execution true/);
  assert.match(macVerifier, /if \(!skipCliExecution\)/);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(publish, /needs\.metadata\.result == 'success'/);
  assert.match(publish, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/release\.yml@refs\/heads\/j2k\/current'/);
  assert.match(publish, /node trusted\/tools\/desktop-release\/desktop-release\.mjs verify-release/);
  assert.match(publish, /node trusted\/tools\/channel-release\/channel-release\.mjs verify-release/);
  assert.doesNotMatch(publish, /node (?:web|desktop)-artifacts\//);
  assert.match(signer, /require\.resolve\(`electron\/package\.json`, \{ paths: \[`\.\/trusted\/packages\/electron`\] \}\)/);
  assert.doesNotMatch(signer, /require\(`\.\/node_modules\/electron\/package\.json`\)/);
});

test('one publisher gates publication on both immutable artifact sets', () => {
  const publish = releaseWorkflow.slice(releaseWorkflow.indexOf('  publish:'));
  assert.match(releaseWorkflow, /needs\.build-desktop\.result == 'success'/);
  assert.match(publish, /desktop-artifacts/);
  assert.match(publish, /web-artifacts/);
  assert.match(publish, /gh api --paginate .*releases\?per_page=100.*--slurp/);
  assert.match(publish, /-F draft=true -F prerelease=true -f make_latest=false/);
  assert.match(publish, /-F draft=true -F prerelease=false/);
  assert.match(publish, /Existing desktop asset \$asset differs; refusing overwrite/);
  assert.match(publish, /Existing release asset \$asset differs; refusing to overwrite/);
  assert.doesNotMatch(publish, /--clobber/);
  assert.ok(publish.indexOf('-F draft=false -F prerelease=true') < publish.indexOf('-F draft=false -F prerelease=false'));
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
  assert.match(releaseWorkflow, /desktop-release\.json/);
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
  assert.match(releaseWorkflow, /same-base commit has no authoritative web or desktop release tag/);
  assert.match(publish, /Refusing to rewind desktop-channel/);
  assert.match(publish, /ls-remote origin "refs\/heads\/\$SOURCE_REF".*= "\$SOURCE_COMMIT"/);
  assert.match(publish, /ls-remote origin refs\/heads\/j2k\/current.*= "\$SOURCE_COMMIT"/);
  assert.match(publish, /permissions:\n      contents: write\n      issues: write/);
  assert.match(publish, /Uploaded web asset \$asset differs from validated bytes/);
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
  ];
  const failures = [];
  for (const [name, source] of workflows) {
    const jobs = YAML.parse(source).jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      (job.steps ?? []).forEach((step, index) => {
        if (typeof step.run !== 'string') return;
        const script = step.run.replace(/\$\{\{[^}]*\}\}/g, 'expression');
        const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
        if (result.status !== 0) failures.push(`${name} ${jobName} step ${index} (${step.name ?? 'unnamed'}): ${result.stderr.trim()}`);
      });
    }
  }
  assert.deepEqual(failures, []);
});
