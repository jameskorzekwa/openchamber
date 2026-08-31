import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
const webWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const macVerifier = readFileSync(new URL('./verify-macos-app.mjs', import.meta.url), 'utf8');

test('desktop release runs automatically or manually only from trusted j2k/current workflow code', () => {
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /- J2K Validate/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/j2k\/current'/);
  assert.match(workflow, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/desktop-release\.yml@refs\/heads\/j2k\/current'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'j2k\/current'/);
  assert.match(workflow, /WORKFLOW_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /No successful J2K Validate run exists for exact source/);
  assert.match(workflow, /source_sha must be an exact lowercase 40-character commit/);
  assert.match(workflow, /Desktop releases may execute and sign only the trusted workflow commit/);
  assert.doesNotMatch(workflow, /j2k\/v/);
});

test('private signing is fingerprint-pinned and never requests Apple notarization', () => {
  assert.match(workflow, /MACOS_PRIVATE_CERTIFICATE_SHA256/);
  assert.match(workflow, /actual_sha256.*expected_sha256/);
  assert.match(workflow, /sudo security add-trusted-cert -d -r trustRoot -p codeSign -k \/Library\/Keychains\/System\.keychain "\$leaf"/);
  assert.match(workflow, /security find-identity -v -p codesigning/);
  assert.match(workflow, /OPENCHAMBER_PRIVATE_MAC_SIGNING: '1'/);
  assert.match(workflow, /--certificate-sha256/);
  assert.doesNotMatch(workflow, /APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|notarytool|stapler staple/);
  assert.match(macVerifier, /`--extract-certificates=\$\{prefix\}`/);
  assert.doesNotMatch(macVerifier, /'--extract-certificates', prefix/);
});

test('candidate build has no write token and publisher runs trusted verifier only', () => {
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(build, /permissions:\n      contents: read/);
  assert.doesNotMatch(build, /contents: write/);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(publish, /needs\.metadata\.result == 'success'/);
  assert.match(publish, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/desktop-release\.yml@refs\/heads\/j2k\/current'/);
  assert.match(publish, /node trusted\/tools\/desktop-release\/desktop-release\.mjs verify-release/);
  assert.doesNotMatch(publish, /node artifacts\//);
  assert.match(build, /require\.resolve\(`electron\/package\.json`, \{ paths: \[`\.\/packages\/electron`\] \}\)/);
  assert.doesNotMatch(build, /require\(`\.\/node_modules\/electron\/package\.json`\)/);
});

test('publication is an immutable resumable draft with exact asset comparison', () => {
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(publish, /gh api --paginate .*releases\?per_page=100.*--slurp/);
  assert.match(workflow, /-F draft=true -F prerelease=true -f make_latest=false/);
  assert.match(workflow, /Existing asset \$asset differs; refusing overwrite/);
  assert.match(workflow, /Uploaded asset \$asset differs from candidate bytes/);
  assert.match(workflow, /Published release is missing \$asset; refusing mutation/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /-F draft=false -F prerelease=true -f make_latest=false/);
  assert.ok(publish.indexOf('-F draft=false -F prerelease=true') < publish.lastIndexOf('refs/heads/desktop-channel'));
});

test('desktop-channel update uses the captured branch lease and contains one manifest', () => {
  assert.match(workflow, /EXPECTED_CHANNEL_COMMIT: \$\{\{ needs\.metadata\.outputs\.channel_commit \}\}/);
  assert.match(workflow, /test "\$current_channel" = "\$EXPECTED_CHANNEL_COMMIT"/);
  assert.match(workflow, /refs\/heads\/desktop-channel:refs\/remotes\/origin\/desktop-channel/);
  assert.match(workflow, /100644 blob %s\\tlatest-mac\.yml/);
  assert.match(workflow, /--force-with-lease=refs\/heads\/desktop-channel:\$EXPECTED_CHANNEL_COMMIT/);
});

test('desktop workflow does not weaken the web release exact-three stable contract', () => {
  assert.match(webWorkflow, /const expected = new Set\(\[`openchamber-web-\$\{process\.env\.VERSION\}\.tgz`, 'SHA256SUMS', 'channel\.json'\]\)/);
  assert.match(webWorkflow, /if \(release\.prerelease\) throw new Error\('Channel release cannot be a prerelease'\)/);
  assert.match(webWorkflow, /-F draft=false -F prerelease=false -f make_latest=true/);
  assert.doesNotMatch(webWorkflow, /latest-mac\.yml|desktop-release\.json/);
});
