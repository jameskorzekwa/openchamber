import assert from 'node:assert/strict';
import test from 'node:test';

import { renderRecoveryIssue, validateRecovery } from './upstream-recovery.mjs';

const base = {
  upstreamRepository: 'openchamber/openchamber',
  upstreamTag: 'v1.22.0',
  upstreamCommit: '1'.repeat(40),
  previousBaseTag: 'v1.21.0',
  patchSeriesSourceCommit: '2'.repeat(40),
  candidateBranch: 'j2k/v1.22.0',
  recreateCommands: [
    'git fetch origin j2k/current j2k/v1.22.0',
    'git rebase --onto v1.22.0 v1.21.0 origin/j2k/current',
  ],
};

test('renders a complete machine-readable textual-conflict handoff', () => {
  const rendered = renderRecoveryIssue({
    ...base,
    failureKind: 'rebase-conflict',
    failedPatchCommit: '3'.repeat(40),
    conflictingFiles: ['packages/web/b.js', 'packages/web/a.js', 'packages/web/a.js'],
  });
  assert.equal(rendered.title, 'OPM recovery: j2k/v1.22.0');
  assert.deepEqual(rendered.recovery.conflictingFiles, ['packages/web/a.js', 'packages/web/b.js']);
  assert.equal(rendered.recovery.eligibleForUnattendedWork, true);
  assert.match(rendered.body, /<!-- opm:upstream-recovery -->/);
  assert.match(rendered.body, /"failedPatchCommit": "3333333333333333333333333333333333333333"/);
  assert.match(rendered.body, /Do not modify `j2k\/current`, tags, releases/);
});

test('renders semantic validation evidence for the same recovery path', () => {
  const rendered = renderRecoveryIssue({
    ...base,
    failureKind: 'semantic-failure',
    candidateCommit: '4'.repeat(40),
    failedCommand: 'bun run test',
    logs: 'AssertionError: expected updater channel j2k',
    workflowUrl: 'https://github.com/jameskorzekwa/openchamber/actions/runs/123',
  });
  assert.equal(rendered.recovery.eligibleForUnattendedWork, true);
  assert.match(rendered.body, /```bash\nbun run test\n```/);
  assert.match(rendered.body, /AssertionError: expected updater channel j2k/);
});

test('marks ambiguous recovery as an owner blocker', () => {
  const recovery = validateRecovery({
    ...base,
    failureKind: 'owner-blocker',
    blockerQuestion: 'Upstream removed the updater hook. Should J2K replace it or stop desktop publication?',
  });
  assert.equal(recovery.eligibleForUnattendedWork, false);
  assert.match(recovery.blockerQuestion, /Should J2K/);
});

test('rejects incomplete recovery contracts before issue creation', () => {
  assert.throws(() => validateRecovery({ ...base, failureKind: 'rebase-conflict', conflictingFiles: ['a'] }), /failedPatchCommit/);
  assert.throws(() => validateRecovery({ ...base, failureKind: 'semantic-failure', candidateCommit: '4'.repeat(40) }), /failedCommand/);
  assert.throws(() => validateRecovery({ ...base, failureKind: 'owner-blocker' }), /blockerQuestion/);
});
