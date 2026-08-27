import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CONTROL_URL = 'http://127.0.0.1:47651';
const POLL_INTERVAL_MS = 10_000;
const FETCH_TIMEOUT_MS = 3_000;

const AUTHORIZE_COMMAND = /\/agent authorize [a-f0-9]{40}/;
const NEEDS_OWNER = /needs owner authorisation/;
const DEAD_LETTER = /exhausted its retries/;

export const readOpmStatusConfig = (configPath) => {
  const file = configPath ?? path.join(os.homedir(), '.config', 'openchamber-opm-status.json');
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = {};
  }

  const controlUrl = (process.env.OPM_CONTROL_URL
    || (typeof parsed.controlUrl === 'string' && parsed.controlUrl)
    || DEFAULT_CONTROL_URL).replace(/\/+$/, '');
  const issueUrls = parsed.issueUrls && typeof parsed.issueUrls === 'object' ? parsed.issueUrls : {};
  return { controlUrl, issueUrls };
};

const issueUrlFor = (issueUrls, project, ref) => {
  const template = issueUrls?.[project];
  if (typeof template !== 'string' || !template.includes('{ref}')) return null;
  return template.replaceAll('{ref}', String(ref));
};

export const ownerGuidance = ({ needsOwner, deadLetter, reason, nextAction, phase, ref }) => {
  if (needsOwner) {
    return {
      required: true,
      instruction: `Post this comment on issue #${ref} to approve the protected change:`,
    };
  }
  if (deadLetter) {
    return {
      required: true,
      instruction: `Something failed repeatedly. Fix the cause (see the error above), then comment "/agent resume" on issue #${ref}.`,
    };
  }

  const text = reason || '';
  if (phase === 'paused') {
    return { required: true, instruction: `You paused this. Comment "/agent resume" on issue #${ref} to continue.` };
  }
  if (/waiting on \d+\/\d+ chunks/.test(text)) {
    return { required: false, instruction: 'Nothing needed from you - this parent finishes when its child items below finish.' };
  }
  if (/waiting for review/.test(text)) {
    return { required: false, instruction: 'Nothing needed from you - OPM dispatches its own reviewer and continues on the verdict. If this sits for more than an hour, comment "/agent resume".' };
  }
  if (/waiting for checks/.test(text)) {
    return { required: false, instruction: 'Nothing needed from you - CI is running on the candidate.' };
  }
  if (/waiting for deployment/.test(text)) {
    return { required: false, instruction: 'Nothing needed from you - the merge is deploying.' };
  }
  if (/worker limit/.test(text)) {
    return { required: false, instruction: 'Nothing needed from you - it starts when a worker slot frees up.' };
  }
  if (phase === 'active' || phase === 'review' || phase === 'planned') {
    return { required: false, instruction: 'Nothing needed from you - OPM is working on it.' };
  }
  return {
    required: false,
    instruction: nextAction
      ? `Nothing obvious for you. OPM says: ${nextAction}`
      : 'Nothing needed from you right now.',
  };
};

const classifyEntry = (entry, activityState, issueUrls) => {
  const reason = typeof entry.reason === 'string' ? entry.reason : '';
  const needsOwner = entry.phase === 'blocked' && NEEDS_OWNER.test(reason);
  const deadLetter = entry.effect?.status === 'dead_letter' || DEAD_LETTER.test(reason);
  const command = needsOwner
    ? (reason.match(AUTHORIZE_COMMAND)?.[0] ?? null)
    : deadLetter
      ? '/agent resume'
      : null;

  return {
    project: entry.project ?? null,
    projectName: entry.projectName ?? null,
    ref: entry.ref,
    title: entry.title ?? '',
    phase: entry.phase ?? null,
    activityState,
    parentRef: entry.parentRef ?? null,
    branch: entry.branch ?? null,
    sessionId: entry.sessionId ?? null,
    workspacePath: entry.workspacePath ?? null,
    reason: reason || null,
    nextAction: entry.nextAction ?? null,
    updatedAt: entry.updatedAt ?? null,
    effect: entry.effect && typeof entry.effect === 'object'
      ? {
          kind: entry.effect.kind ?? null,
          status: entry.effect.status ?? null,
          attempts: entry.effect.attempts ?? null,
          error: entry.effect.error ?? null,
        }
      : null,
    children: Array.isArray(entry.children)
      ? entry.children.map((child) => ({
          ref: child.ref,
          title: child.title ?? '',
          phase: child.phase ?? null,
          activityState: child.activityState ?? null,
          reason: child.reason ?? null,
          url: issueUrlFor(issueUrls, entry.project, child.ref),
        }))
      : [],
    kind: needsOwner ? 'needs-owner' : deadLetter ? 'dead-letter' : null,
    command,
    owner: ownerGuidance({
      needsOwner,
      deadLetter,
      reason,
      nextAction: entry.nextAction ?? null,
      phase: entry.phase ?? null,
      ref: entry.ref,
    }),
    url: issueUrlFor(issueUrls, entry.project, entry.ref),
  };
};

const classifyChildren = (entry, issueUrls) => (Array.isArray(entry.children) ? entry.children : [])
  .filter((child) => child.activityState === 'stopped')
  .map((child) => classifyEntry(
    { ...child, parentRef: entry.ref, project: entry.project, projectName: entry.projectName },
    child.activityState,
    issueUrls,
  ));

const rowRank = (row) => {
  if (row.kind === 'needs-owner' || row.kind === 'dead-letter') return 0;
  if (row.phase === 'blocked' || row.phase === 'failed' || row.phase === 'paused') return 1;
  if (row.phase === 'active' || row.phase === 'review') return 2;
  if (row.phase === 'planned') return 3;
  return 4;
};

export const buildSnapshot = ({ activity, status, issueUrls = {}, now = Date.now() }) => {
  const groups = { needsYou: [], blocked: [], active: [], waiting: [], queued: [] };
  const rows = [];
  const seen = new Set();
  const add = (row) => {
    const key = `${row.project}#${row.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
    if (row.kind === 'needs-owner' || row.kind === 'dead-letter') groups.needsYou.push(row);
    else if (row.phase === 'blocked' || row.phase === 'failed' || row.phase === 'paused') groups.blocked.push(row);
    else if (row.phase === 'planned' || row.activityState === 'queued' || /^queued:/.test(row.reason ?? '')) groups.queued.push(row);
    else if (row.phase === 'active' || row.phase === 'review') groups.active.push(row);
    else groups.waiting.push(row);
  };
  const lists = [
    [activity?.blockers, 'stopped'],
    [activity?.active, 'working'],
    [activity?.queued, 'queued'],
  ];

  // Rich top-level rows win deduplication over inline child summaries.
  for (const [list, activityState] of lists) {
    for (const entry of Array.isArray(list) ? list : []) add(classifyEntry(entry, activityState, issueUrls));
  }
  for (const [list] of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      for (const child of classifyChildren(entry, issueUrls)) add(child);
    }
  }

  const byKey = new Map(rows.map((row) => [`${row.project}#${row.ref}`, row]));
  for (const row of rows) row.childRows = [];
  const tree = [];
  for (const row of rows) {
    const parent = row.parentRef ? byKey.get(`${row.project}#${row.parentRef}`) : null;
    if (parent) parent.childRows.push(row);
    else tree.push(row);
  }
  for (const root of tree) {
    for (const child of root.children ?? []) {
      if (root.childRows.some((existing) => String(existing.ref) === String(child.ref))) continue;
      root.childRows.push({
        ...classifyEntry(
          { ...child, project: root.project, projectName: root.projectName },
          child.activityState ?? 'stopped',
          issueUrls,
        ),
        childRows: [],
      });
    }
    root.childRows.sort((a, b) => rowRank(a) - rowRank(b));
  }
  const treeRank = (row) => Math.min(rowRank(row), ...row.childRows.map(rowRank));
  tree.sort((a, b) => treeRank(a) - treeRank(b));

  return {
    available: true,
    fetchedAt: now,
    state: activity?.state ?? 'idle',
    summary: activity?.summary ?? '',
    healthOk: status?.ok === true,
    paused: status?.paused === true,
    counts: {
      needsYou: groups.needsYou.length,
      blocked: groups.blocked.length,
      active: groups.active.length,
      waiting: groups.waiting.length,
      queued: groups.queued.length,
    },
    groups,
    tree,
    supervisor: {
      running: status?.running === true,
      pausedReason: status?.pausedReason ?? null,
      startedAt: status?.startedAt ?? null,
      lastPollAt: status?.lastPollAt ?? null,
      pollIntervalMs: status?.pollIntervalMs ?? null,
      counters: status?.counters && typeof status.counters === 'object' ? status.counters : {},
      attention: Array.isArray(status?.attention)
        ? status.attention.map((item) => ({
            kind: item.kind ?? null,
            ref: item.ref ?? null,
            detail: item.detail ?? null,
            error: item.error ?? null,
          }))
        : [],
      projects: Array.isArray(status?.projects)
        ? status.projects.map((project) => ({
            projectId: project.projectId ?? null,
            passes: project.passes ?? null,
            failures: project.failures ?? null,
            lastPassAt: project.lastPassAt ?? null,
            degraded: project.degraded === true,
            degradedReason: project.degradedReason ?? null,
            rateLimited: project.rateLimited === true,
            lastError: project.lastError ?? null,
          }))
        : [],
    },
  };
};

const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

export const createOpmStatusPoller = ({ controlUrl, issueUrls, now = Date.now }) => {
  let snapshot = { available: false, fetchedAt: null, error: 'not yet polled' };
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return snapshot;
    inFlight = true;
    try {
      const [activity, status] = await Promise.all([
        fetchJson(`${controlUrl}/activity`),
        fetchJson(`${controlUrl}/status`),
      ]);
      snapshot = buildSnapshot({ activity, status, issueUrls, now: now() });
    } catch (error) {
      snapshot = {
        available: false,
        fetchedAt: now(),
        error: error?.message || String(error),
      };
    } finally {
      inFlight = false;
    }
    return snapshot;
  };
  return { poll, current: () => snapshot };
};

export function registerOpmStatusRoutes(app, options = {}) {
  const config = options.config ?? readOpmStatusConfig(options.configPath);
  const poller = options.poller ?? createOpmStatusPoller(config);
  void poller.poll();
  const timer = setInterval(() => void poller.poll(), options.pollIntervalMs ?? POLL_INTERVAL_MS);
  timer.unref?.();

  app.get('/api/opm/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(poller.current());
  });

  let closed = false;
  return {
    poller,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
    },
  };
}
