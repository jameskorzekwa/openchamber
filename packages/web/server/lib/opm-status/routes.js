import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { createPushoverNotifier } from './pushover-notifier.js';

const DEFAULT_CONTROL_URL = 'http://127.0.0.1:47651';
const POLL_INTERVAL_MS = 10_000;
const FETCH_TIMEOUT_MS = 3_000;
const COMMAND_TIMEOUT_MS = 15_000;
const RESUME_COMMAND = '/agent resume';
// Phases where "/agent resume" can never apply: the item is finished.
const TERMINAL_PHASES = new Set(['completed', 'cancelled', 'verified']);

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
  const repos = parsed.repos && typeof parsed.repos === 'object' ? parsed.repos : {};
  return { controlUrl, issueUrls, repos };
};

// "owner/name" from the explicit repos map, else derived from the issueUrls
// template (https://github.com/OWNER/REPO/issues/{ref}); null when neither
// names the project.
export const resolveRepo = ({ repos, issueUrls }, project) => {
  const explicit = repos?.[project];
  if (typeof explicit === 'string' && /^[\w.-]+\/[\w.-]+$/.test(explicit)) return explicit;
  const template = issueUrls?.[project];
  const match = typeof template === 'string'
    ? template.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\//)
    : null;
  return match ? `${match[1]}/${match[2]}` : null;
};

const issueUrlFor = (issueUrls, project, ref) => {
  const template = issueUrls?.[project];
  if (typeof template !== 'string' || !template.includes('{ref}')) return null;
  return template.replaceAll('{ref}', String(ref));
};

const questionFor = (question) => {
  if (!question || typeof question !== 'object'
    || typeof question.id !== 'string'
    || typeof question.askedBy !== 'string'
    || typeof question.text !== 'string'
    || typeof question.url !== 'string'
    || !Array.isArray(question.options)) return null;
  const options = question.options.map((option) => {
    if (!option || typeof option !== 'object'
      || typeof option.key !== 'string'
      || typeof option.label !== 'string'
      || typeof option.detail !== 'string'
      || typeof option.command !== 'string') return null;
    return {
      key: option.key,
      label: option.label,
      detail: option.detail,
      command: option.command,
    };
  });
  if (options.some((option) => option === null)) return null;
  return {
    id: question.id,
    askedBy: question.askedBy,
    text: question.text,
    options,
    url: question.url,
  };
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
  const question = questionFor(entry.question);
  // OPM marks every owner decision explicitly (waiting_owner phase,
  // needsOwnerDecision + decisionCommand). Matching only the legacy
  // protected-path reason filed those items under blocked/waiting, so the
  // owner was never shown that a decision was his (2026-09-02).
  const needsOwner = entry.needsOwnerDecision === true
    || (entry.phase === 'blocked' && NEEDS_OWNER.test(reason));
  const deadLetter = entry.effect?.status === 'dead_letter' || DEAD_LETTER.test(reason);
  const command = needsOwner
    ? (reason.match(AUTHORIZE_COMMAND)?.[0] ?? entry.decisionCommand ?? null)
    : deadLetter
      ? '/agent resume'
      : null;

  return {
    project: entry.project ?? null,
    projectName: entry.projectName ?? null,
    ref: entry.ref,
    title: entry.title ?? '',
    phase: entry.phase ?? null,
    state: entry.state ?? null,
    action: entry.action ?? null,
    activityState,
    parentRef: entry.parentRef ?? null,
    branch: entry.branch ?? null,
    sessionId: entry.sessionId ?? null,
    workspacePath: entry.workspacePath ?? null,
    alias: entry.alias ?? null,
    activeMs: Number.isFinite(entry.activeMs) ? entry.activeMs : 0,
    activeSince: entry.activeSince ?? null,
    reason: reason || null,
    nextAction: entry.nextAction ?? null,
    needsOwnerDecision: entry.needsOwnerDecision === true,
    question,
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
          state: child.state ?? null,
          action: child.action ?? null,
          activityState: child.activityState ?? null,
          reason: child.reason ?? null,
          needsOwnerDecision: child.needsOwnerDecision === true,
          question: questionFor(child.question),
          url: issueUrlFor(issueUrls, entry.project, child.ref),
        }))
      : [],
    kind: question ? 'owner-question' : needsOwner ? 'needs-owner' : deadLetter ? 'dead-letter' : null,
    command,
    owner: question ? { required: true, instruction: question.text } : ownerGuidance({
      needsOwner,
      deadLetter,
      reason,
      nextAction: entry.nextAction ?? null,
      phase: entry.phase ?? null,
      ref: entry.ref,
    }),
    url: entry.url ?? issueUrlFor(issueUrls, entry.project, entry.ref),
  };
};

// Within a project: what needs the owner, what is actually running (a live
// session on a working action), what is waiting on something, and what has
// not been picked up yet. This is the operator's question every time the
// dashboard opens; the flat groups above answer it across projects only.
const WORKING_ACTIONS = new Set(['active', 'reviewing', 'merging', 'deploying', 'verifying', 'remediating', 'planning', 'closing']);
export const laneFor = (row) => {
  if (row.question || row.kind === 'needs-owner' || row.kind === 'dead-letter') return 'needsYou';
  if (row.phase === 'planned' && (row.action === 'queued' || row.activityState === 'queued')) return 'backlog';
  if (/^queued/.test(row.reason ?? '') || /^queued/.test(row.action ?? '')) return 'backlog';
  if (row.sessionId && WORKING_ACTIONS.has(row.action ?? '') && (row.phase === 'active' || row.phase === 'review')) return 'running';
  return 'waiting';
};

const groupByProject = (rows, statusProjects) => {
  const order = new Map();
  for (const project of statusProjects) {
    const slug = project.project ?? project.slug ?? null;
    if (slug && !order.has(slug)) order.set(slug, { project: slug, projectName: project.projectName ?? project.name ?? slug, alias: null, items: [] });
  }
  for (const row of rows) {
    const slug = row.project ?? 'unknown';
    if (!order.has(slug)) order.set(slug, { project: slug, projectName: row.projectName ?? slug, alias: row.alias ?? null, items: [] });
    const group = order.get(slug);
    if (!group.alias && row.alias) group.alias = row.alias;
    group.items.push({ ...row, lane: laneFor(row) });
  }
  const laneRank = { needsYou: 0, running: 1, waiting: 2, backlog: 3 };
  return [...order.values()].map((group) => {
    group.items.sort((a, b) => laneRank[a.lane] - laneRank[b.lane] || String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }));
    group.counts = { needsYou: 0, running: 0, waiting: 0, backlog: 0 };
    for (const item of group.items) group.counts[item.lane] += 1;
    return group;
  });
};

const classifyChildren = (entry, issueUrls) => (Array.isArray(entry.children) ? entry.children : [])
  .filter((child) => child.activityState === 'stopped')
  .map((child) => classifyEntry(
    { ...child, parentRef: entry.ref, project: entry.project, projectName: entry.projectName },
    child.activityState,
    issueUrls,
  ));

const rowRank = (row) => {
  if (row.kind === 'owner-question' || row.kind === 'needs-owner' || row.kind === 'dead-letter') return 0;
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
    if (row.question || row.kind === 'needs-owner' || row.kind === 'dead-letter') groups.needsYou.push(row);
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

  const statusProjects = Array.isArray(status?.projects) ? status.projects : [];
  const projectById = new Map(statusProjects.map((project) => [project.projectId, project]));
  const projectForAttention = (item) => {
    const configured = projectById.get(item.projectId);
    const project = item.project ?? item.slug ?? configured?.project ?? configured?.slug ?? null;
    const matchingRows = rows.filter((row) => String(row.ref) === String(item.ref));
    const row = matchingRows.find((candidate) => candidate.project === project)
      ?? (matchingRows.length === 1 ? matchingRows[0] : null);
    return {
      project: project ?? row?.project ?? null,
      projectName: item.projectName ?? configured?.projectName ?? row?.projectName ?? null,
    };
  };

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
    byProject: groupByProject(rows, statusProjects),
    completed: Array.isArray(activity?.completed)
      ? activity.completed.map((item) => ({
          project: item.project ?? null,
          projectName: item.projectName ?? null,
          alias: item.alias ?? null,
          ref: item.ref,
          title: item.title ?? '',
          url: item.url ?? issueUrlFor(issueUrls, item.project, item.ref),
          completedAt: item.completedAt ?? null,
          activeMs: Number.isFinite(item.activeMs) ? item.activeMs : 0,
        }))
      : [],
    completedTotal: Number.isFinite(activity?.completedTotal) ? activity.completedTotal : null,
    supervisor: {
      running: status?.running === true,
      pausedReason: status?.pausedReason ?? null,
      startedAt: status?.startedAt ?? null,
      lastPollAt: status?.lastPollAt ?? null,
      pollIntervalMs: status?.pollIntervalMs ?? null,
      counters: status?.counters && typeof status.counters === 'object' ? status.counters : {},
      attention: Array.isArray(status?.attention)
        ? status.attention.map((item) => {
            const identity = projectForAttention(item);
            return {
              kind: item.kind ?? null,
              project: identity.project,
              projectName: identity.projectName,
              ref: item.ref ?? null,
              detail: item.detail ?? null,
              error: item.error ?? null,
              url: identity.project && item.ref ? issueUrlFor(issueUrls, identity.project, item.ref) : null,
            };
          })
        : [],
      projects: statusProjects.map((project) => ({
            projectId: project.projectId ?? null,
            project: project.project ?? project.slug ?? null,
            projectName: project.projectName ?? project.name ?? null,
            passes: project.passes ?? null,
            failures: project.failures ?? null,
            lastPassAt: project.lastPassAt ?? null,
            degraded: project.degraded === true,
            degradedReason: project.degradedReason ?? null,
            rateLimited: project.rateLimited === true,
            lastError: project.lastError ?? null,
          })),
    },
  };
};

const collectRows = (snapshot) => {
  const rows = [];
  const visit = (row) => {
    rows.push(row);
    for (const child of Array.isArray(row.childRows) ? row.childRows : []) visit(child);
  };
  for (const row of Array.isArray(snapshot.tree) ? snapshot.tree : []) visit(row);
  for (const group of Object.values(snapshot.groups ?? {})) {
    for (const row of Array.isArray(group) ? group : []) rows.push(row);
  }
  return rows;
};

// Never execute arbitrary input: a submitted command must re-derive from the
// current snapshot. It is allowed when it exactly equals the (project, ref)
// row's own command, or when it is the literal "/agent resume" for a
// non-terminal row or for a stalled supervisor attention entry on that ref.
export const isCommandAllowed = (snapshot, { project, ref, command }) => {
  if (!snapshot?.available) return false;
  const rows = collectRows(snapshot)
    .filter((row) => String(row.project) === String(project) && String(row.ref) === String(ref));
  for (const row of rows) {
    if (row.command && row.command === command) return true;
    if (command === RESUME_COMMAND && !TERMINAL_PHASES.has(row.phase)) return true;
  }
  return command === RESUME_COMMAND
    && (snapshot.supervisor?.attention ?? []).some((item) => String(item.ref) === String(ref));
};

// Validate that a question decision can be submitted. The question ID must
// match the current snapshot's question for that (project, ref), and either
// the option key must exist or custom text is allowed. Returns the full
// command to post, or null if validation fails.
export const validateQuestionDecision = (snapshot, { project, ref, questionId, optionKey, customText }) => {
  if (!snapshot?.available) return null;
  const rows = collectRows(snapshot)
    .filter((row) => String(row.project) === String(project) && String(row.ref) === String(ref));
  for (const row of rows) {
    if (!row.question || row.question.id !== questionId) continue;
    // Option key submission: find the matching option and return its command
    if (optionKey !== undefined && optionKey !== null) {
      const option = row.question.options.find((opt) => opt.key === optionKey);
      if (option) return option.command;
      return null; // Invalid option key
    }
    // Custom text submission: construct the decide command
    if (typeof customText === 'string' && customText.trim().length > 0) {
      return `/agent decide ${customText.trim()}`;
    }
    return null; // No valid option or custom text
  }
  return null; // Question not found or ID mismatch
};

const parseJsonBody = express.json({ limit: '256kb' });

const fetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

export const createOpmStatusPoller = ({ controlUrl, issueUrls, now = Date.now, notifier = null }) => {
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
      if (notifier) {
        try {
          await notifier.notify(snapshot);
        } catch {
          // Notification delivery must never turn a good snapshot unavailable.
        }
      }
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
  const poller = options.poller
    ?? createOpmStatusPoller({ ...config, notifier: options.notifier ?? createPushoverNotifier() });
  void poller.poll();
  const timer = setInterval(() => void poller.poll(), options.pollIntervalMs ?? POLL_INTERVAL_MS);
  timer.unref?.();

  const execFile = options.execFile ?? nodeExecFile;

  app.get('/api/opm/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(poller.current());
  });

  app.post('/api/opm/command', parseJsonBody, async (req, res) => {
    try {
      const body = req.body;
      const project = typeof body?.project === 'string' ? body.project : null;
      const ref = typeof body?.ref === 'string' || typeof body?.ref === 'number' ? String(body.ref) : null;
      const command = typeof body?.command === 'string' ? body.command : null;
      if (!project || !ref || !command) {
        return res.status(400).json({ ok: false, error: 'project, ref, and command are required' });
      }
      if (!isCommandAllowed(poller.current(), { project, ref, command })) {
        return res.status(400).json({
          ok: false,
          error: `Command does not match the current OPM state for ${project}#${ref}. Refresh and try again.`,
        });
      }
      const repo = resolveRepo(config, project);
      if (!repo) {
        return res.status(400).json({
          ok: false,
          error: `No GitHub repository is configured for project "${project}". Add a repos entry to ~/.config/openchamber-opm-status.json.`,
        });
      }
      try {
        await new Promise((resolve, reject) => {
          execFile(
            'gh',
            ['issue', 'comment', ref, '--repo', repo, '--body', command],
            { timeout: COMMAND_TIMEOUT_MS },
            (error, _stdout, stderr) => {
              if (error) reject(new Error(String(stderr || error.message || error).trim() || 'gh issue comment failed'));
              else resolve(undefined);
            },
          );
        });
      } catch (error) {
        return res.status(502).json({ ok: false, error: error?.message || 'gh issue comment failed' });
      }
      // The comment changes OPM state; poll now so the next snapshot reflects
      // reality sooner than the regular interval would.
      void poller.poll();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || 'unexpected error' });
    }
  });

  // Answer an OPM question by submitting an option key or custom text. The
  // question ID must match the current snapshot to prevent stale submissions.
  app.post('/api/opm/question/decide', parseJsonBody, async (req, res) => {
    try {
      const body = req.body;
      const project = typeof body?.project === 'string' ? body.project : null;
      const ref = typeof body?.ref === 'string' || typeof body?.ref === 'number' ? String(body.ref) : null;
      const questionId = typeof body?.questionId === 'string' ? body.questionId : null;
      const optionKey = typeof body?.optionKey === 'string' ? body.optionKey : null;
      const customText = typeof body?.customText === 'string' ? body.customText : null;

      if (!project || !ref || !questionId) {
        return res.status(400).json({ ok: false, error: 'project, ref, and questionId are required' });
      }
      if (optionKey === null && customText === null) {
        return res.status(400).json({ ok: false, error: 'Either optionKey or customText is required' });
      }

      const command = validateQuestionDecision(poller.current(), { project, ref, questionId, optionKey, customText });
      if (!command) {
        return res.status(400).json({
          ok: false,
          error: optionKey !== null
            ? `Invalid option or stale question for ${project}#${ref}. Refresh and try again.`
            : `Question is stale or invalid for ${project}#${ref}. Refresh and try again.`,
        });
      }

      const repo = resolveRepo(config, project);
      if (!repo) {
        return res.status(400).json({
          ok: false,
          error: `No GitHub repository is configured for project "${project}". Add a repos entry to ~/.config/openchamber-opm-status.json.`,
        });
      }

      try {
        await new Promise((resolve, reject) => {
          execFile(
            'gh',
            ['issue', 'comment', ref, '--repo', repo, '--body', command],
            { timeout: COMMAND_TIMEOUT_MS },
            (error, _stdout, stderr) => {
              if (error) reject(new Error(String(stderr || error.message || error).trim() || 'gh issue comment failed'));
              else resolve(undefined);
            },
          );
        });
      } catch (error) {
        return res.status(502).json({ ok: false, error: error?.message || 'gh issue comment failed' });
      }

      void poller.poll();
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || 'unexpected error' });
    }
  });

  // Pause/resume the supervisor. OPM's control server accepts these only with
  // allowControlMutation; the UI sends the same confirmation header the
  // command route relies on (OpenChamber's own auth already gates the route).
  app.post('/api/opm/pause', parseJsonBody, async (req, res) => {
    // The body is untrusted JSON; accept exactly the two literal states.
    const paused = req.body?.paused === true ? true : req.body?.paused === false ? false : null;
    if (paused === null) return res.status(400).json({ ok: false, error: 'paused (boolean) is required' });
    const target = `${(config.controlUrl ?? DEFAULT_CONTROL_URL).replace(/\/$/, '')}/${paused ? 'pause' : 'resume'}`;
    try {
      const response = await fetch(target, { method: 'POST', signal: AbortSignal.timeout(5000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return res.status(response.status === 403 ? 403 : 502).json({
          ok: false,
          error: response.status === 403 ? 'OPM control mutation is disabled (allowControlMutation)' : (body?.error || `OPM returned ${response.status}`),
        });
      }
      void poller.poll();
      return res.json({ ok: true, paused: body?.paused === true });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error?.message || 'OPM control server unreachable' });
    }
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
