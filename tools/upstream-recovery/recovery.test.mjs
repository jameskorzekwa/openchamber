import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { advanceJob, checkPhase, loadState, newJob, saveState } from './state.mjs';
import { command, createOpenCode, discover, verifyCandidate, workerPrompt } from './bee2.mjs';
import { lockedTickResult, reconcile } from './reconcile.mjs';
import { attentionReason, watchdog } from './watchdog.mjs';
import { taskDefinition } from './schedule.mjs';

const identity = {
  upstreamCommit: '1'.repeat(40), sourceCommit: '2'.repeat(40),
  tag: 'v2.8.0', previousBase: 'v2.7.0', previousBaseCommit: '0'.repeat(40), integrated: false,
};
const options = { now: 1000, maxAttempts: 3, maxRunMs: 7_200_000 };
const success = [{ name: 'Typecheck, lint, test, build, and smoke', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const ports = (overrides = {}) => ({
  pullRequest: async () => null, active: async () => false,
  persist: async () => {}, launch: async () => {}, stop: async () => {}, verifyHead: async () => true, ...overrides,
});

test('persists dispatch identity before worker admission and does not launch twice', async () => {
  const job = newJob(identity, 1000);
  const events = [];
  const adapter = ports({
    persist: async () => events.push(['persist', job.sessionID]),
    launch: async () => events.push(['launch', job.sessionID]),
  });
  await advanceJob(job, adapter, options);
  assert.equal(job.phase, 'running');
  assert.equal(events[0][0], 'persist');
  assert.equal(events[0][1], events[1][1]);
  await advanceJob(job, ports({ active: async () => true, launch: async () => assert.fail('duplicate') }), options);
  assert.equal(job.attempts, 1);
});

test('ambiguous launch failure retains caller IDs for restart', async () => {
  const job = newJob(identity, 1000);
  await assert.rejects(advanceJob(job, ports({ launch: async () => { throw new Error('lost response'); } }), options));
  const sessionID = job.sessionID;
  await advanceJob(job, ports({ launch: async (value) => assert.equal(value.sessionID, sessionID) }), options);
  assert.equal(job.attempts, 1);
});

test('stopped worker retries with backoff and stops at a visible owner decision', async () => {
  const job = newJob(identity, 0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const now = job.nextAttemptAt;
    await advanceJob(job, ports(), { ...options, now });
    assert.equal(job.attempts, attempt);
    await advanceJob(job, ports(), { ...options, now: now + 61_000 });
  }
  assert.equal(job.phase, 'owner-blocked');
  assert.match(job.reason, /without a recovery PR/);
});

test('live overdue worker becomes visible without spawning a competing worker', async () => {
  const job = { ...newJob(identity, 0), phase: 'running', sessionID: 'ses_test', startedAt: 0 };
  let stopped;
  await advanceJob(job, ports({ active: async () => true, stop: async (id) => { stopped = id; }, launch: async () => assert.fail('duplicate') }), { ...options, now: 8_000_000 });
  assert.equal(job.phase, 'owner-blocked');
  assert.equal(stopped, 'ses_test');
});

test('only required successful checks on current PR head reach awaiting approval', async () => {
  assert.equal(checkPhase([]), 'pending');
  assert.equal(checkPhase([{ ...success[0], conclusion: 'SKIPPED' }]), 'pending');
  assert.equal(checkPhase([{ ...success[0], conclusion: 'CANCELLED' }]), 'failed');
  assert.equal(checkPhase(success), 'passed');
  const job = newJob(identity, 0);
  await advanceJob(job, ports({ pullRequest: async () => ({
    state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40), statusCheckRollup: success,
  }) }), options);
  assert.equal(job.phase, 'awaiting-owner-approval');
  assert.equal(job.head, '3'.repeat(40));
  assert.equal(job.attempts, 0);
});

test('missing CI expires visibly', async () => {
  const job = newJob(identity, 0);
  const pr = { state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40), statusCheckRollup: [] };
  const adapter = ports({ pullRequest: async () => pr });
  await advanceJob(job, adapter, options);
  assert.equal(job.phase, 'validating');
  await advanceJob(job, adapter, { ...options, now: 8_000_000 });
  assert.equal(job.phase, 'owner-blocked');
});

test('failed final-head checks retry only after backoff', async () => {
  const job = { ...newJob(identity, 0), phase: 'running', attempts: 1, startedAt: 0 };
  let launches = 0;
  const adapter = ports({
    pullRequest: async () => ({
      state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40),
      statusCheckRollup: [{ ...success[0], conclusion: 'FAILURE' }],
    }),
    launch: async () => { launches++; },
  });
  await advanceJob(job, adapter, options);
  assert.equal(job.phase, 'retry');
  assert.equal(launches, 0);
  await advanceJob(job, adapter, { ...options, now: job.nextAttemptAt });
  assert.equal(job.phase, 'running');
  assert.equal(job.attempts, 2);
  assert.equal(launches, 1);
});

test('corrupt state fails closed and atomic writes round-trip', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-state-'));
  try {
    const file = join(root, 'state.json');
    const state = loadState(file);
    state.jobs.push(newJob(identity, 0));
    saveState(file, state);
    assert.deepEqual(loadState(file), state);
    writeFileSync(file, '{broken');
    assert.throws(() => loadState(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconciler resumes persisted work, preserves fetch errors and waits for old live source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-tick-'));
  let launches = 0;
  let published;
  let live = false;
  let current = identity;
  const adapter = {
    ...ports(), now: () => 1000, discover: async () => current,
    active: async () => live,
    launch: async () => { launches++; live = true; },
    publish: async (state) => { published = structuredClone(state); },
  };
  try {
    await reconcile({ stateDirectory: root }, adapter);
    await reconcile({ stateDirectory: root }, adapter);
    assert.equal(launches, 1);
    current = { ...identity, sourceCommit: '4'.repeat(40) };
    await reconcile({ stateDirectory: root }, adapter);
    assert.match(published.error, /remains active/);
    assert.equal(launches, 1);
    await reconcile({ stateDirectory: root }, { ...adapter, discover: async () => { throw new Error('GitHub offline'); } });
    assert.equal(published.error, 'GitHub offline');
    assert.equal(published.jobs.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed API contract admits a worker over HTTP and reconciles a lost response', async () => {
  const sessions = new Map();
  let admissions = 0;
  let rejected = false;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from('opencode:synthetic').toString('base64')}`) {
      response.writeHead(401).end(); return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.url === '/api/session' && request.method === 'POST') {
      sessions.set(body.id, { ...body, inbox: [] }); send(200, { data: body }); return;
    }
    if (request.url === '/api/session/active') { send(200, { data: {} }); return; }
    const [, , , id, action, messageID] = request.url.split('/');
    const session = sessions.get(id);
    if (!session) { send(404, {}); return; }
    if (!action) { send(200, { data: session }); return; }
    if (action === 'inbox') { send(200, { data: session.inbox }); return; }
    if (action === 'message') { send(404, { messageID }); return; }
    if (action === 'prompt') {
      admissions++;
      session.inbox.push({ id: body.id });
      assert.match(body.text, /Never write j2k\/current/);
      if (!rejected) { rejected = true; response.destroy(); return; }
      send(200, { data: body }); return;
    }
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = createOpenCode({ url: `http://127.0.0.1:${server.address().port}`, password: async () => 'synthetic' });
  const job = { ...newJob(identity, 0), sessionID: 'ses_test', messageID: 'msg_test' };
  try {
    await assert.rejects(api.launch(job, '/isolated/worktree', { providerID: 'test', id: 'test' }));
    await api.launch(job, '/isolated/worktree', { providerID: 'test', id: 'test' });
    assert.equal(sessions.size, 1);
    assert.equal(admissions, 1);
    assert.equal(sessions.get(job.sessionID).location.directory, '/isolated/worktree');
    assert.equal(await api.active(job.sessionID), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('worker and release workflow retain owner integration boundary', () => {
  assert.match(workerPrompt(newJob(identity, 0)), /Every integration requires explicit owner approval/);
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /refs\/heads\/release-source:refs\/heads\/j2k\/current/);
  assert.match(workflow, /test "\$SOURCE_REF" = 'j2k\/current'/);
  assert.doesNotMatch(workflow, /startsWith\(github.event.workflow_run.head_branch, 'j2k\/v'\)/);
});

test('watchdog reports missing, corrupt, stale, and owner-blocked heartbeat', () => {
  const body = (summary) => `\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
  assert.match(attentionReason(null, 1000), /missing/);
  assert.match(attentionReason('not json', 1000), /malformed/);
  assert.match(attentionReason(body({ schema: 1, checkedAt: 0, jobs: [] }), 6_000_000), /stale/);
  assert.equal(attentionReason(body({ schema: 1, checkedAt: 1000, jobs: [] }), 1000), '');
  assert.match(attentionReason(body({ schema: 1, checkedAt: 1000, jobs: [{ tag: 'v2.8.0', phase: 'awaiting-owner-approval' }] }), 1000), /awaiting-owner-approval/);
});

test('watchdog ignores forged heartbeat, deduplicates attention and propagates GitHub failures', async () => {
  const issues = [{
    title: 'Upstream recovery monitor', user: { login: 'unrelated-user' },
    body: '```json\n{"schema":1,"checkedAt":1000,"jobs":[]}\n```',
  }];
  let creates = 0;
  const github = {
    paginate: async () => issues,
    rest: { issues: {
      listForRepo: () => {},
      create: async (issue) => { creates++; issues.push({ ...issue, number: 1, state: 'open', user: { login: 'github-actions[bot]' } }); },
      update: async () => assert.fail('identical alert should not update'),
    } },
  };
  await watchdog(github, { owner: 'test', repo: 'test' }, 1000);
  await watchdog(github, { owner: 'test', repo: 'test' }, 1000);
  assert.equal(creates, 1);
  await assert.rejects(watchdog({ ...github, paginate: async () => { throw new Error('offline'); } }, {}, 1000), /offline/);
});

test('scheduler definition invokes one concrete command with shell-safe paths', () => {
  const task = taskDefinition("/safe/it's/config.json", { providerID: 'test', id: 'model' }, true);
  assert.equal(task.enabled, true);
  assert.equal(task.schedule.cron, '*/15 * * * *');
  assert.match(task.execution.prompt, /reconcile\.mjs' tick '\/safe\/it'\\''s\/config\.json'/);
  assert.equal(task.runInWorktree, false);
});

test('repeated admission errors become owner-blocked while preserving identity', async () => {
  const job = newJob(identity, 0);
  const adapter = ports({ launch: async () => { throw new Error('API unavailable'); } });
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(advanceJob(job, adapter, options), /API unavailable/);
  assert.equal(job.phase, 'owner-blocked');
  assert.equal(job.attempts, 1);
});

test('real Git discovery and green-PR readiness verify upstream ancestry, head and source identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-discovery-'));
  const upstream = join(root, 'upstream');
  const fork = join(root, 'fork');
  const state = join(root, 'state');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Recovery Test', '-c', 'user.email=recovery@example.test', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = (cwd, name) => {
    writeFileSync(join(cwd, 'file.txt'), name);
    git(cwd, 'add', 'file.txt');
    git(cwd, 'commit', '-m', name);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  // Only transport URLs are substituted. Every clone, fetch, sort, tag peel,
  // describe and ancestry operation runs in the real installed Git.
  const transport = (binary, args, cwd) => command(binary, args.map((arg) => {
    if (arg === 'https://github.com/jameskorzekwa/openchamber.git') return fork;
    if (arg === 'https://github.com/openchamber/openchamber.git') return upstream;
    return arg;
  }), cwd);
  try {
    git(root, 'init', '-b', 'main', upstream);
    const base = commit(upstream, 'base');
    git(upstream, 'tag', 'v2.7.0');
    git(root, 'clone', upstream, fork);
    git(fork, 'switch', '-c', 'j2k/current');
    const source = commit(fork, 'custom patch');
    // A fork-only stable-looking tag points at upstream ancestry. The old
    // all-tags selection incorrectly nominated this as the newest release.
    git(fork, 'tag', 'v99.0.0', base);
    commit(upstream, '2.9');
    git(upstream, 'tag', 'v2.9.0');
    const latest = commit(upstream, '2.10');
    git(upstream, 'tag', '-a', 'v2.10.0', '-m', 'stable');
    commit(upstream, 'prerelease');
    git(upstream, 'tag', 'v3.0.0-rc.1');
    git(upstream, 'switch', '-c', 'future');
    commit(upstream, 'unmerged release');
    git(upstream, 'tag', 'v4.0.0');
    git(upstream, 'switch', 'main');

    const found = discover(state, transport);
    assert.equal(found.tag, 'v2.10.0');
    assert.equal(found.upstreamCommit, latest);
    assert.equal(found.sourceCommit, source);
    assert.equal(found.previousBase, 'v2.7.0');
    assert.equal(found.previousBaseCommit, base);
    assert.equal(found.integrated, false);

    const job = newJob(found, 0);
    git(fork, 'branch', job.branch, source);
    const pr = { state: 'OPEN', url: 'https://example.test/pr', headRefOid: source, statusCheckRollup: success };
    assert.equal(verifyCandidate(state, job, pr), false);
    await advanceJob(job, ports({
      pullRequest: async () => pr,
      verifyHead: (entry, candidate) => verifyCandidate(state, entry, candidate),
    }), options);
    assert.equal(job.phase, 'owner-blocked', 'green CI cannot approve an old-base candidate');

    git(fork, 'fetch', upstream, 'main');
    git(fork, 'branch', '-f', job.branch, latest);
    pr.headRefOid = latest;
    assert.equal(verifyCandidate(state, job, pr), true);
    git(fork, 'branch', '-f', job.branch, 'FETCH_HEAD');
    assert.equal(verifyCandidate(state, job, pr), false, 'moved PR head invalidates checked SHA');
    git(fork, 'branch', '-f', job.branch, latest);
    git(fork, 'reset', '--hard', latest);
    assert.equal(verifyCandidate(state, job, pr), false, 'maintained source movement invalidates identity');
    assert.equal(discover(state, transport).integrated, true);

    // A deleted upstream tag must not remain a candidate in the cache.
    git(upstream, 'tag', '-d', 'v2.10.0');
    assert.equal(discover(state, transport).tag, 'v2.9.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real child timeout reports sanitized failure and leaves shared state untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-timeout-'));
  const file = join(root, 'state.json');
  try {
    const original = '{"schema":1,"jobs":[],"checkedAt":1000}\n';
    writeFileSync(file, original);
    const child = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 });
    assert.equal(child.error.code, 'ETIMEDOUT');
    child.error.message = 'sensitive subprocess detail';
    const messages = [];
    assert.equal(lockedTickResult(child, (message) => messages.push(message)), 1);
    assert.match(messages[0], /ETIMEDOUT/);
    assert.match(messages[0], /stale heartbeat/);
    assert.doesNotMatch(messages[0], /sensitive subprocess detail/);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(lockedTickResult({ status: 75 }, () => assert.fail('lock contention is not an error')), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed PR cannot replace dispatch IDs after an ambiguous repair admission', async () => {
  const job = { ...newJob(identity, 0), phase: 'running', attempts: 1, startedAt: 0 };
  let failed = false;
  const launched = [];
  const adapter = ports({
    pullRequest: async () => ({
      state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40),
      statusCheckRollup: [{ ...success[0], conclusion: 'FAILURE' }],
    }),
    launch: async (entry) => {
      launched.push([entry.sessionID, entry.messageID]);
      if (!failed) { failed = true; throw new Error('ambiguous admission'); }
    },
  });
  await advanceJob(job, adapter, options);
  await assert.rejects(advanceJob(job, adapter, { ...options, now: job.nextAttemptAt }), /ambiguous admission/);
  assert.equal(job.attempts, 2);
  await advanceJob(job, adapter, { ...options, now: job.nextAttemptAt + 1 });
  assert.equal(job.phase, 'running');
  assert.equal(job.attempts, 2);
  assert.deepEqual(launched[1], launched[0]);
});

test('restored A identity after A to B transition becomes a visible owner decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-restored-'));
  let current = identity;
  let launches = 0;
  let published;
  const adapter = {
    ...ports(), now: () => 1000, discover: async () => current,
    launch: async () => { launches++; },
    publish: async (state) => { published = structuredClone(state); },
  };
  try {
    await reconcile({ stateDirectory: root }, adapter);
    current = { ...identity, sourceCommit: '4'.repeat(40) };
    await reconcile({ stateDirectory: root }, adapter);
    current = identity;
    await reconcile({ stateDirectory: root }, adapter);
    assert.equal(launches, 2);
    const restored = published.jobs.find((job) => job.sourceCommit === identity.sourceCommit);
    assert.equal(restored.phase, 'owner-blocked');
    assert.match(restored.reason, /restored/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const state of ['CLOSED', 'MERGED']) {
  test(`${state} PR cannot bypass an overdue active worker interruption`, async () => {
    const job = { ...newJob(identity, 0), phase: 'running', sessionID: 'ses_overdue', startedAt: 0 };
    let stopped;
    await advanceJob(job, ports({
      pullRequest: async () => ({ state, url: 'https://example.test/pr' }),
      active: async () => true,
      stop: async (id) => { stopped = id; },
    }), { ...options, now: options.maxRunMs + 1 });
    assert.equal(stopped, 'ses_overdue');
    assert.equal(job.phase, 'owner-blocked');
  });
}

test('green CI cannot claim readiness when exact head verification fails', async () => {
  const job = newJob(identity, 0);
  await advanceJob(job, ports({
    pullRequest: async () => ({ state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40), statusCheckRollup: success }),
    verifyHead: async () => false,
  }), options);
  assert.equal(job.phase, 'owner-blocked');
});
