import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const identityKey = ({ upstreamCommit, sourceCommit }) =>
  createHash('sha256').update(`${upstreamCommit}:${sourceCommit}`).digest('hex').slice(0, 20);

export function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (state.schema !== 1 || !Array.isArray(state.jobs)) throw new Error('Unsupported recovery state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, jobs: [] };
    throw error;
  }
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function newJob(identity, now) {
  const key = identityKey(identity);
  return {
    ...identity, key, branch: `recovery/upstream-${identity.tag}-${key}`,
    phase: 'retry', attempts: 0, createdAt: now,
  };
}

export function prepareAttempt(job, now) {
  job.attempts += 1;
  job.sessionID = `ses_${randomBytes(16).toString('hex')}`;
  job.messageID = `msg_${randomBytes(16).toString('hex')}`;
  job.startedAt = now;
  job.phase = 'dispatching';
}

// The daily tick is the backoff: a tick admits at most one attempt, so a
// failure detected today is repaired today and the attempt cap spans days.
export function retry(job, reason, maxAttempts) {
  job.reason = reason;
  job.phase = job.attempts >= maxAttempts ? 'owner-blocked' : 'retry';
}

// A successful session is not evidence of a successful recovery. Only GitHub
// checks for the current PR head can move a job to owner review.
export function checkPhase(checks) {
  if (!checks.length) return 'pending';
  if (checks.some((check) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE'].includes(check.conclusion || check.state))) return 'failed';
  if (checks.some((check) => check.status !== 'COMPLETED' && check.state !== 'SUCCESS')) return 'pending';
  if (!checks.some((check) => check.name === 'Typecheck, lint, test, build, and smoke' && check.conclusion === 'SUCCESS')) return 'pending';
  return checks.every((check) => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion || check.state)) ? 'passed' : 'failed';
}

async function dispatchAttempt(job, ports, maxAttempts) {
  try {
    await ports.launch(job);
    job.phase = 'running';
    delete job.dispatchFailures;
  } catch (error) {
    job.dispatchFailures = (job.dispatchFailures || 0) + 1;
    if (job.dispatchFailures >= maxAttempts) {
      job.phase = 'owner-blocked';
      job.reason = 'Worker admission failed repeatedly. Inspect its persisted session before retrying.';
    }
    throw error;
  }
}

export async function advanceJob(job, ports, options) {
  const { now, maxAttempts, maxRunMs } = options;
  // Worker lifetime is independent of GitHub availability and PR state.
  const active = job.sessionID && await ports.active(job.sessionID);
  if (active) {
    if (now - job.startedAt > maxRunMs) {
      job.phase = 'owner-blocked';
      job.reason = 'Worker exceeded its time budget. Interrupt requested; inspect the session before resuming.';
      await ports.persist();
      await ports.stop(job.sessionID);
    }
    return;
  }
  const pr = await ports.pullRequest(job);
  if (pr?.state === 'MERGED') {
    job.phase = 'owner-blocked';
    job.reason = 'PR merged, but upstream ancestry is not yet present in the maintained branch. Inspect integration.';
    job.pr = pr.url;
    return;
  }
  if (pr?.state === 'CLOSED') {
    job.phase = 'owner-blocked';
    job.reason = 'Recovery PR closed without integration. Owner decision required.';
    return;
  }
  if (job.phase === 'owner-blocked' || job.phase === 'integrated') return;
  if (job.phase === 'dispatching') {
    // Recover ambiguous admission before the existing failed PR can schedule
    // another attempt and replace the persisted session/message identity.
    await dispatchAttempt(job, ports, maxAttempts);
    return;
  }
  if (pr) {
    job.pr = pr.url;
    if (job.head !== pr.headRefOid) delete job.validationStartedAt;
    job.head = pr.headRefOid;
    const result = checkPhase(pr.statusCheckRollup || []);
    if (result === 'passed') {
      if (!await ports.verifyHead(job, pr)) {
        job.phase = 'owner-blocked';
        job.reason = 'PR head ancestry or maintained source identity differs from the recovery contract. Inspect before approval.';
        return;
      }
      job.phase = 'awaiting-owner-approval';
      job.reason = 'Checks passed for the recorded head. Explicit owner approval is required to integrate.';
      return;
    }
    if (result === 'pending') {
      job.phase = 'validating';
      job.validationStartedAt ??= now;
      if (now - job.validationStartedAt > maxRunMs) {
        job.phase = 'owner-blocked';
        job.reason = 'CI is missing or has not completed within the time budget. Inspect the linked PR.';
      }
      return;
    }
    if (job.phase !== 'retry') retry(job, 'Recovery PR checks failed', maxAttempts);
  } else if (job.phase === 'running' && now - job.startedAt > 60_000) {
    retry(job, 'Worker stopped without a recovery PR', maxAttempts);
  }
  if (job.phase === 'retry') {
    prepareAttempt(job, now);
    await ports.persist();
  }
  if (job.phase === 'dispatching') {
    await dispatchAttempt(job, ports, maxAttempts);
  }
}
