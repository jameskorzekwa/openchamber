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
  assert.equal(rendered.title, 'Upstream recovery: j2k/v1.22.0');
  assert.deepEqual(rendered.recovery.conflictingFiles, ['packages/web/a.js', 'packages/web/b.js']);
  assert.equal(rendered.recovery.eligibleForUnattendedWork, true);
  assert.match(rendered.body, /<!-- j2k:upstream-recovery -->/);
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

const maintained = {
  ...base,
  failureKind: 'semantic-failure',
  upstreamTag: 'v2.8.0',
  previousBaseTag: 'v2.7.0',
  candidateBranch: 'j2k/current',
  candidateCommit: '5'.repeat(40),
  maintainedHeadCommit: '5'.repeat(40),
  failedRunId: '45107464343',
  failedCommand: 'gh workflow run release.yml --ref j2k/current -f source_ref=j2k/current',
  logs: 'Error: Chrome debugging endpoint did not start',
  workflowUrl: 'https://github.com/jameskorzekwa/openchamber/actions/runs/45107464343',
  recreateCommands: [
    'git fetch origin j2k/current',
    'git switch --create recovery/upstream-v2.8.0-release-45107464343 ' + '5'.repeat(40),
    '# Only after owner approval, re-run publication manually: gh workflow run release.yml --ref j2k/current -f source_ref=j2k/current',
  ],
};

test('renders a maintained-branch release failure pinned to its failed run', () => {
  const rendered = renderRecoveryIssue(maintained);
  // The title stays the one successful publication closes.
  assert.equal(rendered.title, 'Upstream recovery: j2k/current');
  assert.equal(rendered.recovery.failedRunId, '45107464343');
  assert.match(rendered.body, /- Failed run: `45107464343`/);
  assert.doesNotMatch(rendered.body, /has since advanced/);
  assert.match(rendered.body, /added as a comment with its own contract/);

  const advanced = renderRecoveryIssue({ ...maintained, maintainedHeadCommit: '6'.repeat(40) });
  assert.equal(advanced.recovery.candidateCommit, '5'.repeat(40));
  assert.match(advanced.body, /has since advanced to `6{40}`; this report stays pinned to the failed commit/);
});

test('accepts the maintained branch only with an exact failed-run identity', () => {
  assert.throws(() => validateRecovery({ ...maintained, failedRunId: undefined }), /failedRunId/);
  assert.throws(() => validateRecovery({ ...maintained, failedRunId: '12x' }), /Invalid failedRunId/);
  assert.throws(() => validateRecovery({ ...maintained, maintainedHeadCommit: 'j2k/current' }), /maintainedHeadCommit/);
  assert.throws(() => validateRecovery({ ...maintained, workflowUrl: 'https://github.com/x/y/actions/runs/1' }), /failed run/);
  assert.throws(() => validateRecovery({ ...maintained, failureKind: 'rebase-conflict', failedPatchCommit: '3'.repeat(40), conflictingFiles: ['a'] }), /semantic failure/);
  assert.throws(() => validateRecovery({ ...maintained, candidateBranch: 'j2k/main' }), /Invalid candidateBranch/);
});

test('maintained-branch recreate commands never rewrite or push', () => {
  for (const command of [
    'git switch --force-create j2k/current ' + '5'.repeat(40),
    'git switch -C j2k/current ' + '5'.repeat(40),
    'git branch -f j2k/current ' + '5'.repeat(40),
    'git reset --hard ' + '5'.repeat(40),
    'git push origin HEAD:j2k/current',
    'git update-ref refs/heads/j2k/current ' + '5'.repeat(40),
  ]) {
    assert.throws(() => validateRecovery({ ...maintained, recreateCommands: [command] }), /must not rewrite or push/, command);
  }
  // Candidate reports keep their existing force-create recreate path.
  assert.doesNotThrow(() => validateRecovery({
    ...base, failureKind: 'semantic-failure', candidateCommit: '4'.repeat(40), failedCommand: 'bun run test', logs: 'x',
    workflowUrl: 'https://github.com/jameskorzekwa/openchamber/actions/runs/1',
    recreateCommands: ['git switch --force-create j2k/v1.22.0 ' + '4'.repeat(40)],
  }));
});
