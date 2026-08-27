import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
const webWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');

test('desktop release runs manually only from trusted j2k/current workflow code', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/j2k\/current'/);
  assert.match(workflow, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/desktop-release\.yml@refs\/heads\/j2k\/current'/);
  assert.match(workflow, /No successful J2K Validate run exists for exact source/);
  assert.match(workflow, /source_sha must be an exact lowercase 40-character commit/);
  assert.match(workflow, /Desktop releases may execute and sign only the trusted workflow commit/);
  assert.doesNotMatch(workflow, /j2k\/v\[0-9\]/);
});

test('private signing is fingerprint-pinned and never requests Apple notarization', () => {
  assert.match(workflow, /MACOS_PRIVATE_CERTIFICATE_SHA256/);
  assert.match(workflow, /actual_sha256.*expected_sha256/);
  assert.match(workflow, /OPENCHAMBER_PRIVATE_MAC_SIGNING: '1'/);
  assert.match(workflow, /--certificate-sha256/);
  assert.doesNotMatch(workflow, /APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|notarytool|stapler staple/);
});

test('candidate build has no write token and publisher runs trusted verifier only', () => {
  const build = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(build, /permissions:\n      contents: read/);
  assert.doesNotMatch(build, /contents: write/);
  assert.match(publish, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(publish, /node trusted\/tools\/desktop-release\/desktop-release\.mjs verify-release/);
  assert.doesNotMatch(publish, /node artifacts\//);
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
