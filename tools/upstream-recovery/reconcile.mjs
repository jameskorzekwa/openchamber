#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceJob, identityKey, loadState, newJob, saveState } from './state.mjs';
import { createOpenCode, discover, gh, GH_REPOSITORY, prepareWorktree, publishHeartbeat, pullRequest, secretPassword, verifyCandidate } from './bee2.mjs';

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

function configuration(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!isAbsolute(config.stateDirectory || '') || !config.model?.providerID || !config.model?.id) {
    throw new Error('Config requires absolute stateDirectory and model {providerID,id}');
  }
  return config;
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
  if (!['tick', 'locked-tick'].includes(mode) || !configFile) throw new Error('Usage: node reconcile.mjs tick <config.json>');
  const config = configuration(configFile);
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  if (mode === 'tick') {
    // Kernel-owned lock releases on exit/crash. A skipped concurrent tick does
    // not replace the last successful heartbeat with an optimistic success.
    const child = spawnSync('flock', ['--no-fork', '--nonblock', '--conflict-exit-code', '75',
      join(config.stateDirectory, 'reconcile.lock'), process.execPath,
      fileURLToPath(import.meta.url), 'locked-tick', resolve(configFile)], { stdio: 'inherit', timeout: 10 * 60_000 });
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
