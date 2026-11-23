import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  advanceJob, checkPhase, loadState, newJob, RELEASE_DISPATCH_GRACE_MS, releasePhase, saveState, VALIDATION_PENDING_LIMIT_MS,
} from './state.mjs';
import {
  BOOTSTRAP_TIMEOUTS, command, createOpenCode, discover, heartbeatBody, prepareWorktree, releaseRuns, verifyCandidate, workerPrompt,
} from './bee2.mjs';
import { discoveryPort, enforceDeadline, lockedTickResult, reconcile } from './reconcile.mjs';
import { attentionReason, STALE_AFTER_MS, watchdog } from './watchdog.mjs';
import {
  configuration, deadlineCalendar, deadlineUnit, ON_CALENDAR, registerDeadline, releaseDeadline,
  renderDeadlineUnits, renderUnits, verifyUnits, writeUnits,
} from './schedule.mjs';

const identity = {
  upstreamCommit: '1'.repeat(40), sourceCommit: '2'.repeat(40),
  tag: 'v2.8.0', previousBase: 'v2.7.0', previousBaseCommit: '0'.repeat(40), integrated: false,
};
const options = { now: 1000, maxAttempts: 3, maxRunMs: 7_200_000 };
const DAY = 24 * 60 * 60_000;
const success = [{ name: 'Typecheck, lint, test, build, and smoke', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const ports = (overrides = {}) => ({
  pullRequest: async () => null, active: async () => false,
  persist: async () => {}, registerDeadline: async () => {}, launch: async () => {}, stop: async () => {},
  verifyHead: async () => true, ...overrides,
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

test('stopped worker retries once per daily tick and stops at a visible owner decision', async () => {
  const job = newJob(identity, 0);
  let launches = 0;
  const adapter = ports({ launch: async () => { launches++; } });
  for (let day = 0; day < 3; day++) {
    await advanceJob(job, adapter, { ...options, now: day * DAY });
    assert.equal(job.attempts, day + 1);
    assert.equal(launches, day + 1);
  }
  await advanceJob(job, adapter, { ...options, now: 3 * DAY });
  assert.equal(job.phase, 'owner-blocked');
  assert.match(job.reason, /without a recovery PR/);
  assert.equal(launches, 3);
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

test('failed final-head checks start one repair attempt in the tick that sees them', async () => {
  const job = { ...newJob(identity, 0), phase: 'running', attempts: 1, startedAt: 0 };
  let launches = 0;
  const adapter = ports({
    pullRequest: async () => ({
      state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40),
      statusCheckRollup: [{ ...success[0], conclusion: 'FAILURE' }],
    }),
    launch: async () => { launches++; },
  });
  await advanceJob(job, adapter, { ...options, now: DAY });
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
  // Daily ticks: yesterday's heartbeat is fresh, a missed tick is stale.
  assert.equal(attentionReason(body({ schema: 1, checkedAt: 0, jobs: [] }), 24 * 60 * 60_000), '');
  assert.match(attentionReason(body({ schema: 1, checkedAt: 0, jobs: [] }), STALE_AFTER_MS + 1), /stale/);
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

test('daily timer runs the reconciler directly, with no model or agent in the schedule', () => {
  const config = '/srv/recovery/config.json';
  const units = renderUnits(config);
  const service = units['j2k-upstream-recovery.service'];
  const script = new URL('./reconcile.mjs', import.meta.url).pathname;
  assert.deepEqual(service.split('\n').filter((line) => line.startsWith('ExecStart')), [`ExecStart=${process.execPath} ${script} tick ${config}`]);
  assert.doesNotMatch(Object.values(units).join('\n'), /model|provider|prompt|opencode run|password|token|secret/i);
  assert.match(units['j2k-upstream-recovery.timer'], /^OnCalendar=\*-\*-\* 08:00:00 UTC$/m);
  assert.match(units['j2k-upstream-recovery.timer'], /^Persistent=true$/m);
  for (const unsafe of ["/safe/it's/config.json", 'relative/config.json', '/a b/config.json', '/50%/config.json']) {
    assert.throws(() => renderUnits(unsafe), /Unit path/);
  }
});

const systemdAnalyze = spawnSync('systemd-analyze', ['--version']).status === 0;
test('real systemd accepts the units and fires once a day at 08:00 UTC', { skip: !systemdAnalyze && 'systemd-analyze unavailable' }, () => {
  const units = renderUnits('/srv/recovery/config.json');
  const result = verifyUnits(units);
  assert.match(result.calendar, new RegExp(`Normalized form: ${ON_CALENDAR.replaceAll('*', '\\*')}`));
  const elapses = [...result.calendar.matchAll(/(?:Next elapse|Iteration #2): \w+ (\S+ \S+) UTC/g)].map((match) => Date.parse(`${match[1]}Z`));
  assert.equal(elapses.length, 2);
  assert.equal(elapses[1] - elapses[0], DAY);
  assert.equal(new Date(elapses[0]).getUTCHours(), 8);
  const broken = { ...units, 'j2k-upstream-recovery.service': units['j2k-upstream-recovery.service'].replace('UMask=', 'Umask=') };
  assert.throws(() => verifyUnits(broken), /Unknown key 'Umask'/);
});

test('installer never overwrites unrelated units and leaves identical units untouched', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-unit-dir-'));
  const units = renderUnits('/srv/recovery/config.json');
  try {
    const foreign = join(directory, 'j2k-upstream-recovery.timer');
    writeFileSync(foreign, '[Timer]\nOnCalendar=hourly\n');
    assert.throws(() => writeUnits(units, directory), /not generated by schedule\.mjs/);
    assert.equal(readFileSync(foreign, 'utf8'), '[Timer]\nOnCalendar=hourly\n');
    assert.equal(existsSync(join(directory, 'j2k-upstream-recovery.service')), false);
    rmSync(foreign);
    assert.deepEqual(writeUnits(units, directory).sort(), ['j2k-upstream-recovery.service', 'j2k-upstream-recovery.timer']);
    const written = statSync(join(directory, 'j2k-upstream-recovery.service'));
    assert.equal(written.mode & 0o777, 0o600);
    assert.deepEqual(writeUnits(units, directory), []);
    assert.equal(statSync(join(directory, 'j2k-upstream-recovery.service')).mtimeMs, written.mtimeMs);
    const moved = renderUnits('/srv/recovery/other.json');
    assert.deepEqual(writeUnits(moved, directory), ['j2k-upstream-recovery.service']);
    assert.equal(readFileSync(join(directory, 'j2k-upstream-recovery.service'), 'utf8'), moved['j2k-upstream-recovery.service']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('daily ticks call a model only for actionable recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-daily-'));
  let now = 0;
  let modelCalls = 0;
  let live = false;
  let current = { ...identity, integrated: true };
  let pr = null;
  let published;
  const adapter = {
    ...ports(), now: () => now, discover: async () => current, active: async () => live,
    launch: async () => { modelCalls++; live = true; }, pullRequest: async () => pr,
    release: async (sha) => ({ releases: [{ headSha: sha, status: 'completed', conclusion: 'success', url: 'https://example.test/run', createdAt: '2026-11-23T05:33:36Z' }], validations: [] }),
    publish: async (state) => { published = structuredClone(state); },
  };
  const tick = async (day) => { now = day * DAY; await reconcile({ stateDirectory: root }, adapter); };
  try {
    for (let day = 0; day < 3; day++) await tick(day);
    assert.equal(modelCalls, 0);
    assert.equal(published.error, undefined);
    assert.equal(published.release.phase, 'released');
    current = identity;
    await tick(3);
    assert.equal(modelCalls, 1);
    live = false;
    pr = { state: 'OPEN', url: 'https://example.test/pr', headRefOid: '3'.repeat(40), statusCheckRollup: [{ ...success[0], status: 'IN_PROGRESS', conclusion: null }] };
    await tick(4);
    assert.equal(published.jobs[0].phase, 'validating');
    pr = { ...pr, statusCheckRollup: success };
    for (let day = 5; day < 8; day++) await tick(day);
    assert.equal(published.jobs[0].phase, 'awaiting-owner-approval');
    assert.equal(published.error, undefined);
    assert.equal(modelCalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worker model defaults to claude-agent opus', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-config-'));
  try {
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ stateDirectory: root }));
    assert.deepEqual(configuration(file).model, { providerID: 'claude-agent', id: 'opus' });
    writeFileSync(file, JSON.stringify({ stateDirectory: root, model: { providerID: 'other', id: 'model' } }));
    assert.deepEqual(configuration(file).model, { providerID: 'other', id: 'model' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('admitted worker is interrupted at its deadline without a reconciliation tick', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-deadline-'));
  const sessions = new Set(['ses_' + 'f'.repeat(32)]);
  const registered = [];
  const stopped = [];
  const released = [];
  let prompts = 0;
  let now = 0;
  try {
    await reconcile({ stateDirectory: root }, {
      ...ports(), now: () => now, discover: async () => identity, publish: async () => {},
      active: async (id) => sessions.has(id),
      registerDeadline: async (job) => { registered.push({ sessionID: job.sessionID, deadlineAt: job.deadlineAt, promptsBefore: prompts }); },
      launch: async (job) => { prompts++; sessions.add(job.sessionID); },
    });
    assert.equal(prompts, 1);
    assert.deepEqual(registered.map(({ promptsBefore, deadlineAt }) => [promptsBefore, deadlineAt]), [[0, 2 * 60 * 60_000]]);
    const { sessionID, deadlineAt } = registered[0];
    const units = renderDeadlineUnits('/srv/recovery/config.json', sessionID, deadlineAt);
    assert.match(units[`${deadlineUnit(sessionID)}.timer`], new RegExp(`^OnCalendar=${deadlineCalendar(deadlineAt)}$`, 'm'));
    assert.match(units[`${deadlineUnit(sessionID)}.timer`], /^Persistent=true$/m);
    assert.match(units[`${deadlineUnit(sessionID)}.service`], new RegExp(` deadline /srv/recovery/config\\.json ${sessionID} ${deadlineAt}$`, 'm'));
    const enforcement = {
      now: () => now, active: async (id) => sessions.has(id),
      stop: async (id) => { stopped.push(id); sessions.delete(id); }, release: async (id) => { released.push(id); },
    };
    now = deadlineAt - 1;
    assert.equal(await enforceDeadline({ stateDirectory: root }, sessionID, deadlineAt, enforcement), 'not-due');
    assert.deepEqual([stopped, released], [[], []]);
    now = deadlineAt;
    assert.equal(await enforceDeadline({ stateDirectory: root }, sessionID, deadlineAt, enforcement), 'enforced');
    assert.deepEqual(stopped, [sessionID]);
    assert.deepEqual(released, [sessionID]);
    assert.equal(sessions.has('ses_' + 'f'.repeat(32)), true);
    const job = loadState(join(root, 'state.json')).jobs[0];
    assert.equal(job.phase, 'owner-blocked');
    assert.match(job.reason, /2-hour deadline/);
    assert.equal(prompts, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deadline keeps its timer while the interrupted session is still active', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-deadline-active-'));
  const sessionID = 'ses_' + 'a'.repeat(32);
  let released = 0;
  try {
    await assert.rejects(enforceDeadline({ stateDirectory: root }, sessionID, 0, {
      now: () => 1, active: async () => true, stop: async () => {}, release: async () => { released++; },
    }), /still active after interrupt/);
    assert.equal(released, 0);
    await assert.rejects(enforceDeadline({ stateDirectory: root }, sessionID, Number('bad'), {
      now: () => 1, active: async () => assert.fail('no session lookup'),
    }), /integer timestamp/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed deadline registration admits no prompt and retries never extend the deadline', async () => {
  const job = newJob(identity, 0);
  const deadlines = [];
  let prompts = 0;
  let registration = 'fail';
  let admission = 'lost';
  const adapter = ports({
    registerDeadline: async (entry) => {
      deadlines.push([entry.sessionID, entry.deadlineAt]);
      if (registration === 'fail') throw new Error('systemd unavailable');
    },
    launch: async () => { if (admission === 'lost') throw new Error('lost response'); prompts++; },
  });
  await assert.rejects(advanceJob(job, adapter, { ...options, now: 0 }), /systemd unavailable/);
  assert.equal(prompts, 0);
  assert.equal(job.phase, 'dispatching');
  registration = 'ok';
  await assert.rejects(advanceJob(job, adapter, { ...options, now: 60 * 60_000 }), /lost response/);
  admission = 'ok';
  await advanceJob(job, adapter, { ...options, now: 90 * 60_000 });
  assert.equal(prompts, 1);
  assert.equal(job.attempts, 1);
  assert.deepEqual(new Set(deadlines.map(String)), new Set([`${job.sessionID},${2 * 60 * 60_000}`]));
  assert.equal(deadlines.length, 3);
});

test('an unconfirmed admission past its deadline is never admitted late', async () => {
  const job = newJob(identity, 0);
  const launched = [];
  const adapter = ports({ launch: async (entry) => { launched.push(entry.sessionID); throw new Error('lost response'); } });
  await assert.rejects(advanceJob(job, adapter, { ...options, now: 0 }), /lost response/);
  const first = job.sessionID;
  await assert.rejects(advanceJob(job, adapter, { ...options, now: DAY }), /lost response/);
  assert.deepEqual(launched.slice(0, 1), [first]);
  assert.notEqual(launched[1], first);
  assert.equal(job.attempts, 2);
  assert.equal(job.deadlineAt, DAY + 2 * 60 * 60_000);
});

test('deadline registration verifies real units, refuses foreign files and reads back the timer', { skip: !systemdAnalyze && 'systemd-analyze unavailable' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-deadline-units-'));
  const sessionID = 'ses_' + 'b'.repeat(32);
  const other = 'ses_' + 'c'.repeat(32);
  const deadlineAt = Math.ceil((Date.now() + 2 * 60 * 60_000) / 1000) * 1000;
  const name = deadlineUnit(sessionID);
  const calls = [];
  let active = 'active';
  const systemctl = (args) => {
    calls.push(args.join(' '));
    return args[0] === 'show' ? `ActiveState=${active}\nUnitFileState=enabled\n` : '';
  };
  try {
    const { calendar } = verifyUnits(renderDeadlineUnits('/srv/recovery/config.json', sessionID, deadlineAt), deadlineCalendar(deadlineAt));
    const next = calendar.match(/Next elapse: \w+ (\S+ \S+) UTC/)[1];
    assert.equal(Date.parse(`${next}Z`), deadlineAt);
    writeFileSync(join(directory, `${name}.timer`), '[Timer]\nOnCalendar=hourly\n');
    assert.throws(() => registerDeadline('/srv/recovery/config.json', { sessionID, deadlineAt }, { directory, systemctl }), /not generated/);
    assert.deepEqual(calls, []);
    rmSync(join(directory, `${name}.timer`));
    registerDeadline('/srv/recovery/config.json', { sessionID, deadlineAt }, { directory, systemctl });
    registerDeadline('/srv/recovery/config.json', { sessionID: other, deadlineAt }, { directory, systemctl });
    assert.deepEqual(calls.slice(0, 3), ['daemon-reload', `enable --now ${name}.timer`, `show ${name}.timer -p ActiveState,UnitFileState`]);
    const written = statSync(join(directory, `${name}.timer`)).mtimeMs;
    registerDeadline('/srv/recovery/config.json', { sessionID, deadlineAt }, { directory, systemctl });
    assert.equal(statSync(join(directory, `${name}.timer`)).mtimeMs, written);
    active = 'inactive';
    assert.throws(() => registerDeadline('/srv/recovery/config.json', { sessionID, deadlineAt }, { directory, systemctl }), /not active and enabled/);
    releaseDeadline(sessionID, { directory, systemctl });
    assert.equal(existsSync(join(directory, `${name}.timer`)), false);
    assert.equal(existsSync(join(directory, `${name}.service`)), false);
    assert.equal(existsSync(join(directory, `${deadlineUnit(other)}.timer`)), true);
    assert.deepEqual(calls.slice(-3), [`disable --now ${name}.timer`, `clean --what=state ${name}.timer`, 'daemon-reload']);
    releaseDeadline(sessionID, { directory, systemctl });
    assert.deepEqual(calls.slice(-1), ['daemon-reload']);
    assert.equal(calls.filter((call) => call.startsWith('disable')).length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
    // Annotated, like older upstream releases: describe would print v2.7.0-N-g….
    git(upstream, 'tag', '-a', 'v2.7.0', '-m', 'stable');
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

// Cold-start fixture: bare fork and upstream served over file:// with
// uploadpack.allowFilter, so --filter and --dissociate run in real Git.
function coldStartFixture() {
  const root = mkdtempSync(join(tmpdir(), 'recovery-coldstart-'));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Recovery Test', '-c', 'user.email=recovery@example.test', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const work = join(root, 'work');
  const upstream = join(root, 'upstream.git');
  const fork = join(root, 'fork.git');
  git(root, 'init', '-q', '-b', 'main', work);
  const commit = (name, file = 'file.txt') => {
    writeFileSync(join(work, file), name);
    git(work, 'add', file);
    git(work, 'commit', '-q', '-m', name);
    return git(work, 'rev-parse', 'HEAD');
  };
  commit('base');
  commit('keep', 'kept.txt');
  git(work, 'tag', '-a', 'v2.7.0', '-m', 'stable');
  const latest = commit('2.8');
  git(work, 'tag', 'v2.8.0');
  git(work, 'switch', '-q', '-c', 'j2k', 'v2.7.0');
  const forkSource = commit('custom patch', 'patch.txt');
  // A fork-only stable-looking tag must not nominate an upstream release.
  git(work, 'tag', 'v9.9.9');
  git(root, 'init', '-q', '--bare', '-b', 'main', upstream);
  git(root, 'init', '-q', '--bare', '-b', 'main', fork);
  git(work, 'push', '-q', upstream, 'main:refs/heads/main', 'refs/tags/v2.7.0', 'refs/tags/v2.8.0');
  git(work, 'push', '-q', fork, 'j2k:refs/heads/j2k/current', 'refs/tags/v2.7.0', 'refs/tags/v9.9.9');
  for (const repository of [upstream, fork]) git(repository, 'config', 'uploadpack.allowFilter', 'true');
  const urls = {
    'https://github.com/jameskorzekwa/openchamber.git': `file://${fork}`,
    'https://github.com/openchamber/openchamber.git': `file://${upstream}`,
  };
  const calls = [];
  // Only transport URLs are substituted; the timeout reaches the real child.
  const transport = (binary, args, cwd, timeout) => {
    calls.push(args);
    return command(binary, args.map((arg) => urls[arg] ?? arg), cwd, timeout);
  };
  return { root, git, fork, source: forkSource, latest, transport, calls, state: join(root, 'state') };
}

test('cold start without a local reference bootstraps a blobless clone that keeps exact ancestry', () => {
  const fixture = coldStartFixture();
  const { git, state } = fixture;
  try {
    const found = discover(state, fixture.transport);
    assert.equal(found.tag, 'v2.8.0');
    assert.equal(found.upstreamCommit, fixture.latest);
    assert.equal(found.sourceCommit, fixture.source);
    // The annotated upstream v2.7.0 base resolves to its own commit.
    assert.equal(found.previousBase, 'v2.7.0');
    assert.equal(found.previousBaseCommit, git(fixture.fork, 'rev-parse', 'v2.7.0^{commit}'));
    assert.notEqual(found.previousBaseCommit, fixture.source);
    assert.equal(found.integrated, false);
    const clone = fixture.calls.find((args) => args[0] === 'clone');
    assert.ok(clone.includes('--filter=blob:none') && !clone.includes('--depth'), 'full history, blobs on demand');
    const repository = join(state, 'repository');
    assert.equal(git(repository, 'config', 'remote.origin.partialclonefilter'), 'blob:none');
    assert.equal(git(repository, 'rev-parse', '--is-shallow-repository'), 'false');
    assert.deepEqual(readdirSync(state), ['repository'], 'no staging directory remains');
    // A worker worktree still checks out real file contents from origin.
    const job = { ...newJob(found, 0), key: 'cold' };
    const worktree = prepareWorktree(state, job);
    assert.equal(readFileSync(join(worktree, 'patch.txt'), 'utf8'), 'custom patch');
    assert.equal(readFileSync(join(worktree, 'kept.txt'), 'utf8'), 'keep');
    // The bootstrapped cache is reused; a second tick does not clone again.
    fixture.calls.length = 0;
    assert.equal(discover(state, fixture.transport).sourceCommit, fixture.source);
    assert.equal(fixture.calls.some((args) => args[0] === 'clone'), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('local reference bootstraps a dissociated cache that survives losing the reference', () => {
  const fixture = coldStartFixture();
  const { git, state } = fixture;
  const reference = join(fixture.root, 'primary');
  try {
    git(fixture.root, 'clone', '-q', fixture.fork, reference);
    // The tick's port passes the configured reference through.
    const found = discoveryPort({ stateDirectory: state, referenceRepository: reference }, fixture.transport)();
    assert.equal(found.sourceCommit, fixture.source);
    const clone = fixture.calls.find((args) => args[0] === 'clone');
    assert.deepEqual(clone.slice(2, 5), ['--reference', reference, '--dissociate']);
    const repository = join(state, 'repository');
    assert.equal(existsSync(join(repository, '.git', 'objects', 'info', 'alternates')), false);
    rmSync(reference, { recursive: true, force: true });
    git(repository, 'fsck', '--connectivity-only', '--no-dangling');
    const worktree = prepareWorktree(state, { ...newJob(found, 0), key: 'reference' });
    assert.equal(readFileSync(join(worktree, 'kept.txt'), 'utf8'), 'keep');
    assert.equal(discover(state, fixture.transport).upstreamCommit, fixture.latest);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a reference stored at the legacy staging path survives and yields a dissociated cache', () => {
  const fixture = coldStartFixture();
  const { git, state } = fixture;
  const reference = join(state, 'repository.bootstrap');
  try {
    mkdirSync(state);
    git(fixture.root, 'clone', '-q', fixture.fork, reference);
    const refs = () => git(reference, 'for-each-ref', '--format=%(refname) %(objectname)');
    const before = refs();
    assert.match(before, /refs\/remotes\/origin\/j2k\/current/);
    const found = discover(state, fixture.transport, { reference });
    assert.equal(found.sourceCommit, fixture.source);
    assert.deepEqual(fixture.calls.find((args) => args[0] === 'clone').slice(2, 5), ['--reference', reference, '--dissociate']);
    assert.equal(refs(), before, 'reference is untouched');
    git(reference, 'fsck', '--connectivity-only', '--no-dangling');
    const repository = join(state, 'repository');
    assert.equal(existsSync(join(repository, '.git', 'objects', 'info', 'alternates')), false);
    assert.deepEqual(readdirSync(state).sort(), ['repository', 'repository.bootstrap']);
    rmSync(reference, { recursive: true, force: true });
    const worktree = prepareWorktree(state, { ...newJob(found, 0), key: 'legacy' });
    assert.equal(readFileSync(join(worktree, 'kept.txt'), 'utf8'), 'keep');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('missing or broken reference falls back to the blobless bootstrap', () => {
  const fixture = coldStartFixture();
  const notARepository = join(fixture.root, 'not-a-repository');
  try {
    mkdirSync(notARepository);
    const found = discover(fixture.state, fixture.transport, { reference: notARepository });
    assert.equal(found.sourceCommit, fixture.source);
    assert.deepEqual(fixture.calls.filter((args) => args[0] === 'clone').map((args) => args[2]), ['--reference', '--filter=blob:none']);
    rmSync(join(fixture.state, 'repository'), { recursive: true, force: true });
    fixture.calls.length = 0;
    assert.equal(discover(fixture.state, fixture.transport, { reference: join(fixture.root, 'absent') }).tag, 'v2.8.0');
    assert.deepEqual(fixture.calls.filter((args) => args[0] === 'clone').map((args) => args[2]), ['--filter=blob:none']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('slow cold bootstrap times out with a next action, leaves no partial cache and recovers next tick', () => {
  const fixture = coldStartFixture();
  const { state } = fixture;
  try {
    mkdirSync(state);
    writeFileSync(join(state, 'state.json'), 'unrelated');
    // Arbitrary pre-existing data at the old fixed staging path, which a
    // failed bootstrap must not remove.
    mkdirSync(join(state, 'repository.bootstrap'));
    writeFileSync(join(state, 'repository.bootstrap', 'owner'), 'owner data');
    // A real `git clone` child is killed by its timeout.
    const slow = (binary, args, cwd, timeout) => {
      if (args[0] === 'clone') return fixture.transport('sh', ['-c', 'exec sleep 5'], cwd, timeout);
      return fixture.transport(binary, args, cwd, timeout);
    };
    assert.throws(() => discover(state, slow, { reference: fixture.fork, timeouts: { reference: 100, total: 300 } }), (error) => {
      assert.match(error.message, /^Cold bootstrap of .*repository failed \(reference: sh -c timed out after 0s\./);
      assert.match(error.message, /blobless: sh -c timed out after 0s/);
      assert.match(error.message, /Next action: seed it with "git clone --no-checkout --filter=blob:none https:\/\/github.com\/jameskorzekwa\/openchamber.git /);
      assert.doesNotMatch(error.message, /authentication/);
      return true;
    });
    assert.equal(existsSync(join(state, 'repository')), false);
    assert.equal(readFileSync(join(state, 'repository.bootstrap', 'owner'), 'utf8'), 'owner data');
    assert.equal(readFileSync(join(state, 'state.json'), 'utf8'), 'unrelated');
    const remaining = () => readdirSync(state).sort();
    assert.deepEqual(remaining(), ['repository.bootstrap', 'state.json'], 'only the owned staging directory is removed');
    // The cache is still missing; the next tick bootstraps it normally.
    assert.equal(discover(state, fixture.transport).sourceCommit, fixture.source);
    assert.equal(readFileSync(join(state, 'state.json'), 'utf8'), 'unrelated');
    assert.equal(readFileSync(join(state, 'repository.bootstrap', 'owner'), 'utf8'), 'owner data');
    assert.deepEqual(remaining(), ['repository', 'repository.bootstrap', 'state.json']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('bootstrap budget fits the locked tick and never clears an unrecognized cache directory', () => {
  assert.ok(BOOTSTRAP_TIMEOUTS.reference < BOOTSTRAP_TIMEOUTS.total);
  assert.ok(BOOTSTRAP_TIMEOUTS.total + 2 * 120_000 <= 10 * 60_000 - 60_000, 'clone budget plus both fetches leaves 60s of the 10-minute tick');
  const root = mkdtempSync(join(tmpdir(), 'recovery-foreign-'));
  try {
    mkdirSync(join(root, 'repository'));
    writeFileSync(join(root, 'repository', 'keep'), 'owner data');
    assert.throws(() => discover(root, () => assert.fail('no Git command may run')), /exists but is not a Git checkout/);
    assert.equal(readFileSync(join(root, 'repository', 'keep'), 'utf8'), 'owner data');
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ stateDirectory: root, referenceRepository: 'relative/primary' }));
    assert.throws(() => configuration(config), /referenceRepository must be an absolute path/);
    writeFileSync(config, JSON.stringify({ stateDirectory: root, referenceRepository: '/srv/primary' }));
    assert.equal(configuration(config).referenceRepository, '/srv/primary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('command reports a real timeout distinctly from a failed exit status', () => {
  assert.throws(() => command('sh', ['-c', 'exec sleep 5'], undefined, 100), /^Error: sh -c timed out after 0s\. Inspect network throughput/);
  assert.throws(() => command('sh', ['-c', 'echo secret >&2; exit 7']), (error) => {
    assert.equal(error.message, 'sh -c failed (status 7). Inspect local authentication/network health.');
    return true;
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_OLD = 'b'.repeat(40);
const T0 = Date.parse('2026-11-23T05:14:46Z');
const validateRun = (overrides = {}) => ({
  headSha: SHA_A, headBranch: 'j2k/current', event: 'push', status: 'in_progress', conclusion: '',
  url: 'https://example.test/validate', createdAt: '2026-11-23T05:14:46Z', updatedAt: '2026-11-23T05:20:00Z', ...overrides,
});
const releaseRun = (overrides = {}) => ({
  headSha: SHA_A, headBranch: 'j2k/current', event: 'workflow_run', status: 'completed', conclusion: 'success',
  url: 'https://example.test/release', createdAt: '2026-11-23T05:33:36Z', updatedAt: '2026-11-23T05:50:00Z', ...overrides,
});

test('release phase: exact-SHA validation in progress is pending, everything else unreleased is an error', () => {
  const at = (minutes) => T0 + minutes * 60_000;
  const phase = (runs, now = at(10)) => releasePhase(SHA_A, runs, now);
  assert.deepEqual(phase({ releases: [releaseRun()] }), { phase: 'released', url: 'https://example.test/release' });
  // Existing semantics: an unfinished or failed release run is an error.
  for (const run of [releaseRun({ status: 'in_progress', conclusion: '' }), releaseRun({ conclusion: 'failure' }), releaseRun({ conclusion: 'cancelled' })]) {
    assert.match(phase({ releases: [run], validations: [validateRun()] }).error, /release requires attention: https:\/\/example.test\/release$/);
  }
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const pending = phase({ releases: [releaseRun({ conclusion: 'skipped' })], validations: [validateRun({ status })] });
    assert.equal(pending.phase, 'validating');
    assert.equal(pending.error, undefined);
    assert.match(pending.reason, new RegExp(`^Not released: J2K Validate is ${status} for ${SHA_A}`));
  }
  // Runs for another SHA, a PR validation or another branch never explain a missing release.
  const mismatched = phase({
    releases: [releaseRun({ headSha: SHA_OLD })],
    validations: [validateRun({ headSha: SHA_OLD }), validateRun({ event: 'pull_request' }), validateRun({ headBranch: 'j2k/v2.8.0' })],
  });
  assert.equal(mismatched.phase, 'attention');
  assert.match(mismatched.error, /no release run for current SHA; no J2K Validate push run for a{40}$/);
  assert.match(phase({}).error, /no J2K Validate push run/);
  // Pending is bounded by run age.
  assert.equal(phase({ validations: [validateRun()] }, T0 + VALIDATION_PENDING_LIMIT_MS).phase, 'validating');
  assert.match(phase({ validations: [validateRun()] }, T0 + VALIDATION_PENDING_LIMIT_MS + 1).error, /still in_progress after 6 hours/);
  assert.equal(phase({ validations: [validateRun({ createdAt: 'not a date' })] }).phase, 'attention');
  assert.equal(phase({ validations: [validateRun()] }, T0 - 1).phase, 'attention', 'a run from the future is not trusted');
  // Successful validation without a release: short dispatch grace, then an error.
  const done = validateRun({ status: 'completed', conclusion: 'success', updatedAt: '2026-11-23T05:33:34Z' });
  const finished = Date.parse(done.updatedAt);
  assert.equal(phase({ validations: [done] }, finished + RELEASE_DISPATCH_GRACE_MS).phase, 'release-dispatch-pending');
  assert.match(phase({ validations: [done] }, finished + RELEASE_DISPATCH_GRACE_MS + 1).error, /succeeded but no release run started within 30 minutes/);
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    assert.match(phase({ validations: [validateRun({ status: 'completed', conclusion })] }).error, new RegExp(`ended ${conclusion}$`));
  }
  // The newest exact-SHA run decides.
  const rerun = [validateRun({ status: 'completed', conclusion: 'failure' }), validateRun({ createdAt: '2026-11-23T05:20:00Z', url: 'https://example.test/rerun' })];
  assert.equal(phase({ validations: rerun }).url, 'https://example.test/rerun');
});

test('pending validation publishes a not-released heartbeat that the watchdog does not alarm on; failure still alarms', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-release-'));
  let runs = { releases: [], validations: [validateRun()] };
  let published;
  let current = { ...identity, sourceCommit: SHA_A, integrated: true };
  const adapter = {
    ...ports(), now: () => T0 + 10 * 60_000, discover: async () => current,
    release: async (sha) => { assert.equal(sha, SHA_A); return runs; },
    publish: async (state) => { published = heartbeatBody(state); },
  };
  try {
    const state = await reconcile({ stateDirectory: root }, adapter);
    assert.equal(state.error, undefined, 'a pending release is not an error, so the tick exits 0');
    assert.deepEqual(state.release, { sourceCommit: SHA_A, phase: 'validating', url: 'https://example.test/validate', reason: state.release.reason });
    assert.match(published, /"phase": "validating"/);
    assert.match(published, /\n\nNot released: J2K Validate is in_progress for a{40}/);
    assert.equal(attentionReason(published, T0 + 11 * 60_000), '');

    runs = { releases: [], validations: [validateRun({ status: 'completed', conclusion: 'failure' })] };
    const failed = await reconcile({ stateDirectory: root }, adapter);
    assert.match(failed.error, /ended failure$/);
    assert.doesNotMatch(published, /Not released:/);
    assert.match(attentionReason(published, T0 + 11 * 60_000), /release requires attention: no release run for current SHA; J2K Validate https:\/\/example.test\/validate ended failure/);

    runs = { releases: [], validations: [] };
    assert.match(attentionReason((await reconcile({ stateDirectory: root }, adapter), published), T0 + 11 * 60_000), /no J2K Validate push run/);

    // A tick that is not integrated carries no stale release phase.
    current = { ...identity, sourceCommit: SHA_A };
    assert.equal((await reconcile({ stateDirectory: root }, adapter)).release, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release adapter queries both workflows for the exact SHA through a real gh child', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-gh-'));
  const stub = join(root, 'gh');
  try {
    writeFileSync(join(root, 'release.yml.json'), JSON.stringify([releaseRun({ headSha: SHA_OLD }), releaseRun({ conclusion: 'skipped' })]));
    writeFileSync(join(root, 'validate.yml.json'), JSON.stringify([validateRun({ status: 'queued' })]));
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/calls'\nwhile [ $# -gt 0 ]; do [ "$1" = --workflow ] && workflow=$2; shift; done\ncat '${root}/'"$workflow.json"\n`, { mode: 0o700 });
    const run = (binary, args, cwd, timeout) => { assert.equal(binary, 'gh'); return command(stub, args, cwd, timeout); };
    const runs = releaseRuns(SHA_A, run);
    const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
    assert.deepEqual(calls.map((line) => line.split(' ').slice(0, 10).join(' ')), [
      `run list --repo github.com/jameskorzekwa/openchamber --workflow release.yml --commit ${SHA_A} --limit 20`,
      `run list --repo github.com/jameskorzekwa/openchamber --workflow validate.yml --commit ${SHA_A} --limit 20`,
    ]);
    const result = releasePhase(SHA_A, runs, T0 + 60_000);
    assert.equal(result.phase, 'validating', 'old-SHA and skipped release runs are ignored');
    assert.match(result.reason, /J2K Validate is queued/);
    assert.throws(() => releaseRuns('abc', () => assert.fail('no lookup for an invalid SHA')), /full commit SHA/);
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
  await assert.rejects(advanceJob(job, adapter, { ...options, now: DAY }), /ambiguous admission/);
  assert.equal(job.attempts, 2);
  await advanceJob(job, adapter, { ...options, now: DAY + 60_000 });
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
