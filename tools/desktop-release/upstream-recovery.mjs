#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const BRANCH_PATTERN = /^j2k\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FAILURE_KINDS = new Set(['rebase-conflict', 'semantic-failure', 'owner-blocker']);
// Publication only follows the maintained branch, so a release failure names
// it rather than a candidate. Such a report is pinned to one failed run.
const MAINTAINED_BRANCH = 'j2k/current';
const RUN_ID_PATTERN = /^[1-9]\d*$/;
// A maintained-branch recreate command may not rewrite or push anything;
// commented lines are owner instructions, not commands.
const REWRITING_COMMAND = /\bpush\b|\breset\b|--force|\s-[CBf]\b|\bupdate-ref\b|\bbranch\s+-[dDfM]\b/;

const fail = (message) => { throw new Error(message); };
const requireText = (value, name) => {
  if (value == null || value !== String(value) || !value.trim()) fail(`Missing ${name}`);
  return value.trim();
};
const requireCommit = (value, name) => {
  const commit = requireText(value, name);
  return COMMIT_PATTERN.test(commit) ? commit : fail(`Invalid ${name}: ${value}`);
};

export function validateRecovery(input) {
  const failureKind = requireText(input.failureKind, 'failureKind');
  if (!FAILURE_KINDS.has(failureKind)) fail(`Invalid failureKind: ${failureKind}`);
  const upstreamTag = requireText(input.upstreamTag, 'upstreamTag');
  if (!TAG_PATTERN.test(upstreamTag)) fail(`Invalid upstreamTag: ${upstreamTag}`);
  const previousBaseTag = requireText(input.previousBaseTag, 'previousBaseTag');
  if (!TAG_PATTERN.test(previousBaseTag)) fail(`Invalid previousBaseTag: ${previousBaseTag}`);
  const candidateBranch = requireText(input.candidateBranch, 'candidateBranch');
  const maintained = candidateBranch === MAINTAINED_BRANCH;
  if (!maintained && !BRANCH_PATTERN.test(candidateBranch)) fail(`Invalid candidateBranch: ${candidateBranch}`);

  const recovery = {
    schema: 1,
    failureKind,
    eligibleForUnattendedWork: failureKind !== 'owner-blocker',
    upstreamRepository: requireText(input.upstreamRepository, 'upstreamRepository'),
    upstreamTag,
    upstreamCommit: requireCommit(input.upstreamCommit, 'upstreamCommit'),
    previousBaseTag,
    patchSeriesSourceCommit: requireCommit(input.patchSeriesSourceCommit, 'patchSeriesSourceCommit'),
    candidateBranch,
    candidateCommit: input.candidateCommit ? requireCommit(input.candidateCommit, 'candidateCommit') : null,
    failedPatchCommit: input.failedPatchCommit ? requireCommit(input.failedPatchCommit, 'failedPatchCommit') : null,
    conflictingFiles: Array.isArray(input.conflictingFiles) ? [...new Set(input.conflictingFiles.map(String).filter(Boolean))].sort() : [],
    failedCommand: input.failedCommand ? requireText(input.failedCommand, 'failedCommand') : null,
    logs: input.logs ? String(input.logs).trim() : null,
    workflowUrl: input.workflowUrl ? requireText(input.workflowUrl, 'workflowUrl') : null,
    recreateCommands: Array.isArray(input.recreateCommands)
      ? input.recreateCommands.map((command) => requireText(command, 'recreateCommands[]'))
      : fail('Missing recreateCommands'),
    blockerQuestion: input.blockerQuestion ? requireText(input.blockerQuestion, 'blockerQuestion') : null,
  };
  if (maintained) {
    if (failureKind !== 'semantic-failure') fail(`${MAINTAINED_BRANCH} recovery must be a semantic failure`);
    const failedRunId = requireText(input.failedRunId, 'failedRunId');
    if (!RUN_ID_PATTERN.test(failedRunId)) fail(`Invalid failedRunId: ${failedRunId}`);
    recovery.failedRunId = failedRunId;
    recovery.maintainedHeadCommit = requireCommit(input.maintainedHeadCommit, 'maintainedHeadCommit');
  }

  if (recovery.recreateCommands.length === 0) fail('recreateCommands must not be empty');
  if (failureKind === 'rebase-conflict' && (!recovery.failedPatchCommit || recovery.conflictingFiles.length === 0)) {
    fail('Rebase recovery requires failedPatchCommit and conflictingFiles');
  }
  if (failureKind === 'semantic-failure' && (!recovery.candidateCommit || !recovery.failedCommand || !recovery.logs || !recovery.workflowUrl)) {
    fail('Semantic recovery requires candidateCommit, failedCommand, logs, and workflowUrl');
  }
  if (failureKind === 'owner-blocker' && !recovery.blockerQuestion) fail('Owner blocker requires blockerQuestion');
  if (maintained) {
    if (!recovery.workflowUrl.endsWith(`/actions/runs/${recovery.failedRunId}`)) fail('workflowUrl must be the failed run');
    const rewriting = recovery.recreateCommands.find((command) => !command.startsWith('#') && REWRITING_COMMAND.test(command));
    if (rewriting) fail(`${MAINTAINED_BRANCH} recreate commands must not rewrite or push: ${rewriting}`);
  }
  return recovery;
}

export function recoveryTitle(recovery) {
  return `Upstream recovery: ${recovery.candidateBranch}`;
}

export function renderRecoveryIssue(input) {
  const recovery = validateRecovery(input);
  const lines = [
    '<!-- j2k:upstream-recovery -->',
    '## Recovery contract',
    '',
    '```json',
    JSON.stringify(recovery, null, 2),
    '```',
    '',
    '## Source identity',
    '',
    `- Upstream: \`${recovery.upstreamRepository}\` \`${recovery.upstreamTag}\` at \`${recovery.upstreamCommit}\``,
    `- Previous J2K base: \`${recovery.previousBaseTag}\``,
    `- Patch-series source: \`${recovery.patchSeriesSourceCommit}\``,
    `- Candidate branch: \`${recovery.candidateBranch}\``,
  ];
  if (recovery.candidateCommit) lines.push(`- Candidate commit: \`${recovery.candidateCommit}\``);
  if (recovery.failedRunId) {
    lines.push(`- Failed run: \`${recovery.failedRunId}\``);
    if (recovery.maintainedHeadCommit !== recovery.candidateCommit) {
      lines.push(`- \`${MAINTAINED_BRANCH}\` has since advanced to \`${recovery.maintainedHeadCommit}\`; this report stays pinned to the failed commit.`);
    }
    lines.push('', `Each later \`${MAINTAINED_BRANCH}\` failure is added as a comment with its own contract; earlier reports are kept.`);
  }
  if (recovery.failedPatchCommit) lines.push(`- Failed patch: \`${recovery.failedPatchCommit}\``);
  if (recovery.conflictingFiles.length) lines.push('', '## Conflicting files', '', '```text', ...recovery.conflictingFiles, '```');
  if (recovery.failedCommand) lines.push('', '## Failed command', '', '```bash', recovery.failedCommand, '```');
  if (recovery.logs) lines.push('', '## Failure log', '', '```text', recovery.logs, '```');
  if (recovery.workflowUrl) lines.push('', `Workflow: ${recovery.workflowUrl}`);
  lines.push('', '## Recreate', '', '```bash', ...recovery.recreateCommands, '```');
  if (recovery.blockerQuestion) lines.push('', '## Owner decision required', '', recovery.blockerQuestion);
  lines.push('', 'Do not modify `j2k/current`, tags, releases, or release-channel branches while this recovery is open.', '');
  return { recovery, title: recoveryTitle(recovery), body: lines.join('\n') };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key || '<end>'}`);
    const name = key.slice(2);
    if (!['input', 'body', 'title'].includes(name)) fail(`Unknown option: --${name}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate option: --${name}`);
    options[name] = value;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(requireText(options.input, '--input'));
  const rendered = renderRecoveryIssue(JSON.parse(readFileSync(inputPath, 'utf8')));
  if (options.body) writeFileSync(resolve(options.body), rendered.body);
  if (options.title) writeFileSync(resolve(options.title), `${rendered.title}\n`);
  if (!options.body && !options.title) process.stdout.write(rendered.body);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
