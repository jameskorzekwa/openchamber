import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemver } from './semver.mjs';

test('compares stable and J2K prerelease versions with SemVer precedence', () => {
  assert.ok(compareSemver('1.21.1-j2k.1', '1.21.0') > 0);
  assert.ok(compareSemver('1.21.0-j2k.1', '1.21.0') < 0);
  assert.ok(compareSemver('1.21.0-j2k.10', '1.21.0-j2k.2') > 0);
  assert.equal(compareSemver('v1.21.0-j2k.2+build.1', '1.21.0-j2k.2'), 0);
});

test('fails closed for malformed versions', () => {
  assert.equal(compareSemver('1.21', '1.21.0'), 0);
  assert.equal(compareSemver('not-a-version', '1.21.0'), 0);
});
