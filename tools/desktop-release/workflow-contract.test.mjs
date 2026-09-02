import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
const webWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const syncWorkflow = readFileSync(new URL('../../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8');
const recoveryWorkflow = readFileSync(new URL('../../.github/workflows/recover-upstream-release.yml', import.meta.url), 'utf8');
const validateWorkflow = readFileSync(new URL('../../.github/workflows/validate.yml', import.meta.url), 'utf8');
const macVerifier = readFileSync(new URL('./verify-macos-app.mjs', import.meta.url), 'utf8');

test('desktop release is a build-only component for an exact candidate', () => {
  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.match(workflow, /source_sha must be an exact lowercase 40-character commit/);
  assert.match(workflow, /source_ref must be a candidate branch/);
  assert.match(workflow, /source_commit.*INPUT_SOURCE_SHA/);
  assert.doesNotMatch(workflow, /^  publish:/m);
  assert.match(webWorkflow, /uses: \.\/\.github\/workflows\/desktop-release\.yml/);
  assert.match(webWorkflow, /source_sha: \$\{\{ needs\.metadata\.outputs\.source_commit \}\}/);
});

test('private signing is fingerprint-pinned and never requests Apple notarization', () => {
  assert.match(workflow, /MACOS_PRIVATE_CERTIFICATE_SHA256/);
  assert.match(workflow, /actual_sha256.*expected_sha256/);
  assert.match(workflow, /sudo security add-trusted-cert -d -r trustRoot -p codeSign -k \/Library\/Keychains\/System\.keychain "\$leaf"/);
  assert.match(workflow, /security find-identity -v -p codesigning/);
  assert.match(workflow, /import \{ signAsync \} from '@electron\/osx-sign'/);
  assert.match(workflow, /--certificate-sha256/);
  assert.doesNotMatch(workflow, /APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|notarytool|stapler staple/);
  assert.match(macVerifier, /`--extract-certificates=\$\{prefix\}`/);
  assert.doesNotMatch(macVerifier, /'--extract-certificates', prefix/);
});

test('candidate build has no write token and publisher runs trusted verifier only', () => {
  const build = workflow.slice(workflow.indexOf('  candidate-build:'), workflow.indexOf('  sign-and-verify:'));
  const signer = workflow.slice(workflow.indexOf('  sign-and-verify:'));
  const publish = webWorkflow.slice(webWorkflow.indexOf('  publish:'));
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
  const publish = webWorkflow.slice(webWorkflow.indexOf('  publish:'));
  assert.match(webWorkflow, /needs\.build-desktop\.result == 'success'/);
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
  assert.match(webWorkflow, /EXPECTED_DESKTOP_CHANNEL: \$\{\{ needs\.metadata\.outputs\.desktop_channel_commit \}\}/);
  assert.match(webWorkflow, /test "\$current_channel" = "\$EXPECTED_DESKTOP_CHANNEL"/);
  assert.match(webWorkflow, /refs\/heads\/desktop-channel:refs\/remotes\/origin\/desktop-channel/);
  assert.match(webWorkflow, /100644 blob %s\\tlatest-mac\.yml/);
  assert.match(webWorkflow, /--force-with-lease=refs\/heads\/desktop-channel:\$EXPECTED_DESKTOP_CHANNEL/);
});

test('unified workflow preserves the web release exact-three stable contract', () => {
  assert.match(webWorkflow, /const expected = new Set\(\[`openchamber-web-\$\{process\.env\.VERSION\}\.tgz`, 'SHA256SUMS', 'channel\.json'\]\)/);
  assert.match(webWorkflow, /if \(release\.prerelease\) throw new Error\('Channel release cannot be a prerelease'\)/);
  assert.match(webWorkflow, /-F draft=false -F prerelease=false -f make_latest=true/);
  assert.match(webWorkflow, /desktop-release\.json/);
});

test('conflicts create owner-authored OPM recovery without touching release refs', () => {
  assert.match(syncWorkflow, /OPM_RECOVERY_GITHUB_TOKEN/);
  assert.match(syncWorkflow, /owner_id.*38769771/);
  assert.match(syncWorkflow, /upstream-recovery\.mjs/);
  assert.match(syncWorkflow, /--label opm:ready/);
  const conflictPath = syncWorkflow.slice(syncWorkflow.indexOf('if ! git rebase'), syncWorkflow.indexOf('git push origin "HEAD:refs/heads/$branch"'));
  assert.doesNotMatch(conflictPath, /refs\/heads\/j2k\/current|gh release|refs\/tags/);
});

test('semantic release failures use the same recovery contract', () => {
  assert.match(recoveryWorkflow, /workflows:\n      - J2K Validate\n      - J2K Release/);
  assert.match(recoveryWorkflow, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(recoveryWorkflow, /gh run download "\$FAILED_RUN_ID".*--name release-identity/);
  assert.match(webWorkflow, /commit="\$\(git rev-parse refs\/remotes\/origin\/recovery-source\)"/);
  assert.match(recoveryWorkflow, /upstream-recovery\.mjs/);
  assert.match(recoveryWorkflow, /--label opm:ready/);
  assert.doesNotMatch(recoveryWorkflow, /contents: write/);
  assert.doesNotMatch(validateWorkflow, /OPM_RECOVERY_GITHUB_TOKEN: \$\{\{ secrets/);
});

test('publication rechecks source leases and refuses branch rewinds', () => {
  const publish = webWorkflow.slice(webWorkflow.indexOf('  publish:'));
  assert.match(webWorkflow, /Refusing to rewind j2k\/current/);
  assert.match(webWorkflow, /desktop-v\*-j2k\.\*/);
  assert.match(webWorkflow, /same-base commit has no authoritative web or desktop release tag/);
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
  assert.match(webWorkflow.slice(webWorkflow.indexOf('  publish:')), /environment: j2k-release/);
  assert.doesNotMatch(webWorkflow, /secrets:\n      MACOS_PRIVATE_CERTIFICATE/);
});
