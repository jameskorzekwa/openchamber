#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceJob, identityKey, loadState, newJob, saveState } from './state.mjs';
import { createOpenCode, discover, gh, GH_REPOSITORY, prepareWorktree, publishHeartbeat, pullRequest, secretPassword, verifyCandidate } from './bee2.mjs';
import { configuration, registerDeadline, releaseDeadline } from './schedule.mjs';

export async function reconcile(config, ports) {
  const file = join(config.stateDirectory, 'state.json');
  const state = loadState(file);
  const persist = () => saveState(file, state);
  const now = ports.now();
  state.checkedAt = now;
  delete state.error;
  try {
    const identity = await ports.discover();
    state.current = {
      tag: identity.tag, sourceCommit: identity.sourceCommit,
      upstreamCommit: identity.upstreamCommit, integrated: identity.integrated,
    };
    const key = identityKey(identity);
    // A changed source cannot steal an active worker's branch. Retain every
    // older job and worktree until its owner can review or discard it.
    for (const job of state.jobs) {
      if (job.key === key || ['superseded', 'integrated'].includes(job.phase)) continue;
      if (job.sessionID && await ports.active(job.sessionID)) {
        if (now - job.startedAt > 2 * 60 * 60_000) {
          job.phase = 'owner-blocked';
          job.reason = 'Superseded worker exceeded its time budget; interrupt requested.';
          persist();
          await ports.stop(job.sessionID);
        }
        state.error = `Previous recovery ${job.key} remains active; new source ${key} waits.`;
        persist();
        await ports.publish(state);
        return state;
      }
      job.phase = 'superseded';
      job.reason = `Source changed; retained for review. Replacement identity ${key}.`;
    }
    if (identity.integrated) {
      for (const job of state.jobs.filter((entry) => entry.upstreamCommit === identity.upstreamCommit)) job.phase = 'integrated';
      const release = await ports.release(identity.sourceCommit);
      if (!release || release.status !== 'completed' || release.conclusion !== 'success') {
        state.error = `Upstream integrated, release requires attention: ${release?.url || 'no release run for current SHA'}`;
      }
    } else {
      let job = state.jobs.find((entry) => entry.key === key);
      if (!job) {
        job = newJob(identity, now);
        state.jobs.push(job);
        persist();
      } else if (['superseded', 'integrated'].includes(job.phase)) {
        job.phase = 'owner-blocked';
        job.reason = 'A previous recovery identity was restored. Review its retained session, branch and PR before retrying.';
      }
      await advanceJob(job, { ...ports, persist }, {
        now, maxAttempts: 3, maxRunMs: 2 * 60 * 60_000,
      });
    }
  } catch (error) {
    // Do not change dispatch IDs after ambiguous API failures. The next tick
    // inspects the persisted session and inbox before trying admission again.
    state.error = error.message;
  }
  persist();
  await ports.publish(state);
  return state;
}

// Runs from one attempt's deadline timer, without a reconciliation tick.
// Interrupts exactly that session if it is still active at its deadline, and
// releases the timer only once the session is inactive. A failure throws so
// systemd's bounded restart tries again.
export async function enforceDeadline(config, sessionID, deadlineAt, ports) {
  if (!Number.isSafeInteger(deadlineAt)) throw new Error('Deadline must be an integer timestamp');
  if (ports.now() < deadlineAt) return 'not-due';
  if (await ports.active(sessionID)) {
    const file = join(config.stateDirectory, 'state.json');
    const state = loadState(file);
    const job = state.jobs.find((entry) => entry.sessionID === sessionID);
    if (job && job.phase !== 'owner-blocked') {
      job.phase = 'owner-blocked';
      job.reason = 'Worker reached its 2-hour deadline. Interrupt requested; inspect the session before resuming.';
      saveState(file, state);
    }
    await ports.stop(sessionID);
    if (await ports.active(sessionID)) throw new Error(`Session ${sessionID} is still active after interrupt`);
  }
  await ports.release(sessionID);
  return 'enforced';
}

export function lockedTickResult(child, report = console.error) {
  if (child.error || child.status === null) {
    const code = ['ETIMEDOUT', 'ENOENT', 'EACCES'].includes(child.error?.code) ? child.error.code : 'SPAWN_FAILED';
    const signal = ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(child.signal) ? child.signal : 'none';
    report(`Recovery tick wrapper failed: ${code}; signal ${signal}. Shared state and heartbeat were not updated by the wrapper; the watchdog can detect a stale heartbeat on its next successful run.`);
    return 1;
  }
  return child.status === 75 ? 0 : child.status;
}

async function main() {
  const [mode, configFile] = process.argv.slice(2);
  if (!['tick', 'locked-tick', 'deadline', 'locked-deadline'].includes(mode) || !configFile) {
    throw new Error('Usage: node reconcile.mjs tick <config.json> | deadline <config.json> <sessionID> <deadlineAt>');
  }
  const config = configuration(configFile);
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const lock = join(config.stateDirectory, 'reconcile.lock');
  const self = fileURLToPath(import.meta.url);
  if (mode === 'deadline') {
    // Waits out a running tick (bounded at 10 minutes); a lock timeout fails
    // the unit so its bounded restart retries.
    const child = spawnSync('flock', ['--no-fork', '--wait', '720', lock, process.execPath, self, 'locked-deadline',
      resolve(configFile), ...process.argv.slice(4)], { stdio: 'inherit', timeout: 13 * 60_000 });
    process.exitCode = lockedTickResult(child);
    return;
  }
  if (mode === 'locked-deadline') {
    const [sessionID, deadlineAt] = process.argv.slice(4);
    const api = createOpenCode({ password: secretPassword() });
    const outcome = await enforceDeadline(config, sessionID, Number(deadlineAt), {
      now: Date.now, active: api.active, stop: api.stop, release: releaseDeadline,
    });
    console.log(JSON.stringify({ sessionID, outcome }));
    return;
  }
  if (mode === 'tick') {
    // Kernel-owned lock releases on exit/crash. A skipped concurrent tick does
    // not replace the last successful heartbeat with an optimistic success.
    const child = spawnSync('flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '75',
      lock, process.execPath, self, 'locked-tick', resolve(configFile)], { stdio: 'inherit', timeout: 10 * 60_000 });
    process.exitCode = lockedTickResult(child);
    return;
  }
  if (gh('api', '--hostname', 'github.com', 'user').login !== 'jameskorzekwa') throw new Error('Recovery requires the existing jameskorzekwa GitHub identity');
  const api = createOpenCode({ password: secretPassword() });
  const state = await reconcile(config, {
    now: Date.now,
    discover: () => discover(config.stateDirectory),
    active: api.active,
    stop: api.stop,
    pullRequest,
    verifyHead: (job, pr) => verifyCandidate(config.stateDirectory, job, pr),
    registerDeadline: (job) => registerDeadline(resolve(configFile), job),
    launch: (job) => api.launch(job, prepareWorktree(config.stateDirectory, job), config.model),
    release: (sha) => gh('run', 'list', '--repo', GH_REPOSITORY, '--workflow', 'release.yml',
      '--commit', sha, '--limit', '10', '--json', 'status,conclusion,url').find((run) => run.conclusion !== 'skipped'),
    publish: publishHeartbeat,
  });
  console.log(JSON.stringify({ checkedAt: state.checkedAt, error: state.error || null, jobs: state.jobs.map(({ key, phase }) => ({ key, phase })) }));
  if (state.error) process.exitCode = 1;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Child process errors can include credential helpers' output. Keep those
    // out of public reports and logs; HTTP adapter errors contain status only.
    console.error('Recovery tick failed. Inspect state.json and local service health.');
    process.exitCode = 1;
  });
}
