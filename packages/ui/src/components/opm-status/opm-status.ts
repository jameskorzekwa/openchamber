import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();

const ownerSchema = z.object({
  required: z.boolean(),
  instruction: z.string(),
});

const effectSchema = z.object({
  kind: nullableString,
  status: nullableString,
  attempts: nullableNumber,
  error: nullableString,
}).nullable();

const childSummarySchema = z.object({
  ref: z.union([z.string(), z.number()]),
  title: z.string(),
  phase: nullableString,
  state: nullableString.default(null),
  action: nullableString.default(null),
  activityState: nullableString,
  reason: nullableString,
  needsOwnerDecision: z.boolean().default(false),
  question: z.object({
    id: z.string(),
    askedBy: z.string(),
    text: z.string(),
    options: z.array(z.object({
      key: z.string(),
      label: z.string(),
      detail: z.string(),
      command: z.string(),
    })),
    url: z.string(),
  }).nullable().default(null),
  url: nullableString,
});

const rowBaseSchema = z.object({
  project: nullableString,
  projectName: nullableString,
  ref: z.union([z.string(), z.number()]),
  title: z.string(),
  phase: nullableString,
  state: nullableString.default(null),
  action: nullableString.default(null),
  activityState: z.string(),
  parentRef: z.union([z.string(), z.number()]).nullable(),
  branch: nullableString,
  sessionId: nullableString,
  workspacePath: nullableString,
  reason: nullableString,
  nextAction: nullableString,
  needsOwnerDecision: z.boolean().default(false),
  question: childSummarySchema.shape.question,
  updatedAt: z.union([z.string(), z.number()]).nullable(),
  effect: effectSchema,
  children: z.array(childSummarySchema),
  kind: z.enum(['owner-question', 'needs-owner', 'dead-letter']).nullable(),
  command: nullableString,
  owner: ownerSchema,
  url: nullableString,
});

export type OpmRow = z.infer<typeof rowBaseSchema>;
export type OpmTreeRow = OpmRow & { childRows: OpmTreeRow[] };

const treeRowSchema: z.ZodType<OpmTreeRow> = z.lazy(() => rowBaseSchema.extend({
  childRows: z.array(treeRowSchema),
}));
const groupsSchema = z.object({
  needsYou: z.array(rowBaseSchema),
  blocked: z.array(rowBaseSchema),
  active: z.array(rowBaseSchema),
  waiting: z.array(rowBaseSchema),
  queued: z.array(rowBaseSchema),
});

const availableSnapshotSchema = z.object({
  available: z.literal(true),
  fetchedAt: z.number(),
  state: z.string(),
  summary: z.string(),
  healthOk: z.boolean(),
  paused: z.boolean(),
  counts: z.object({
    needsYou: z.number(),
    blocked: z.number(),
    active: z.number(),
    waiting: z.number(),
    queued: z.number(),
  }),
  groups: groupsSchema,
  tree: z.array(treeRowSchema),
  supervisor: z.object({
    running: z.boolean(),
    pausedReason: nullableString,
    startedAt: nullableNumber,
    lastPollAt: nullableNumber,
    pollIntervalMs: nullableNumber,
    counters: z.object({
      deadLetters: z.number().optional(),
      blocked: z.number().optional(),
      unpropagatedObjectiveRevisions: z.number().optional(),
    }).passthrough(),
    attention: z.array(z.object({
      kind: nullableString,
      project: nullableString.default(null),
      projectName: nullableString.default(null),
      ref: z.union([z.string(), z.number()]).nullable(),
      detail: nullableString,
      error: nullableString,
      url: nullableString.default(null),
    })),
    projects: z.array(z.object({
      projectId: nullableString,
      project: nullableString.default(null),
      projectName: nullableString.default(null),
      passes: nullableNumber,
      failures: nullableNumber,
      lastPassAt: nullableNumber,
      degraded: z.boolean(),
      degradedReason: nullableString,
      rateLimited: z.boolean(),
      lastError: nullableString,
    })),
  }),
});

const unavailableSnapshotSchema = z.object({
  available: z.literal(false),
  fetchedAt: nullableNumber,
  error: z.string(),
});

const snapshotSchema = z.discriminatedUnion('available', [availableSnapshotSchema, unavailableSnapshotSchema]);

export type OpmSnapshot = z.infer<typeof snapshotSchema>;
type OpmSnapshotPayload = z.input<typeof snapshotSchema>;
export type OpmAvailableSnapshot = z.infer<typeof availableSnapshotSchema>;
export type OpmAttention = OpmAvailableSnapshot['supervisor']['attention'][number];

export type OpmStatusLoadResult =
  | { status: 'supported'; snapshot: OpmSnapshot }
  | { status: 'unsupported' };

type SessionOpener = (sessionId: string, workspacePath: string | null) => void;

export const openOpmRowSession = (row: OpmRow, openSession: SessionOpener) => {
  if (!row.sessionId) return false;
  openSession(row.sessionId, row.workspacePath);
  return true;
};

export const parseOpmSnapshot = (payload: OpmSnapshotPayload): OpmSnapshot => snapshotSchema.parse(payload);

export const fetchOpmStatus = async (): Promise<OpmStatusLoadResult> => {
  let response: Response;
  try {
    response = await runtimeFetch('/api/opm/status', { cache: 'no-store' });
  } catch {
    return {
      status: 'supported',
      snapshot: { available: false, fetchedAt: Date.now(), error: 'request failed' },
    };
  }
  if (response.status === 404 || response.status === 501) return { status: 'unsupported' };
  if (!response.ok) {
    return {
      status: 'supported',
      snapshot: { available: false, fetchedAt: Date.now(), error: `request returned ${response.status}` },
    };
  }

  try {
    return { status: 'supported', snapshot: parseOpmSnapshot(await response.json()) };
  } catch {
    return {
      status: 'supported',
      snapshot: { available: false, fetchedAt: Date.now(), error: 'invalid response' },
    };
  }
};

export type OpmCommandResult = { ok: true } | { ok: false; error: string };

const commandResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

// Posts a row's command for server-side re-validation and execution as a
// GitHub issue comment. Every failure becomes { ok: false, error } so the
// caller renders it inline instead of throwing.
export const postOpmCommand = async (row: OpmRow): Promise<OpmCommandResult> => {
  if (!row.command) return { ok: false, error: 'No command to run' };
  let response: Response;
  try {
    response = await runtimeFetch('/api/opm/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: row.project, ref: row.ref, command: row.command }),
    });
  } catch {
    return { ok: false, error: 'Request failed' };
  }
  try {
    return commandResultSchema.parse(await response.json());
  } catch {
    return { ok: false, error: `Request returned ${response.status}` };
  }
};

export const getOpmCounts = (snapshot: OpmAvailableSnapshot) => ({
  needsYou: snapshot.groups.needsYou.length,
  blocked: snapshot.groups.blocked.length,
  active: snapshot.groups.active.length,
  waiting: snapshot.groups.waiting.length,
  queued: snapshot.groups.queued.length,
});

const countTreeRows = (rows: OpmTreeRow[]): number => rows.reduce(
  (total, row) => total + 1 + countTreeRows(row.childRows),
  0,
);

// The pill always reports every registered in-flight item. The hierarchy is
// authoritative because the status groups classify the same rows by state.
export const getTotalOpmCount = (snapshot: OpmSnapshot): number | null => {
  if (!snapshot.available) return null;
  return countTreeRows(snapshot.tree);
};

export const ownerGuidanceKind = (row: OpmRow) => {
  if (row.kind === 'owner-question') return 'question';
  if (row.kind === 'needs-owner') return 'authorize';
  if (row.kind === 'dead-letter') return 'deadLetter';
  if (row.phase === 'paused') return 'paused';
  const reason = row.reason ?? '';
  if (/waiting on \d+\/\d+ chunks/.test(reason)) return 'children';
  if (/waiting for review/.test(reason)) return 'review';
  if (/waiting for checks/.test(reason)) return 'checks';
  if (/waiting for deployment/.test(reason)) return 'deployment';
  if (/worker limit/.test(reason)) return 'worker';
  if (row.phase === 'active' || row.phase === 'review' || row.phase === 'planned') return 'working';
  return row.nextAction ? 'nextAction' : 'none';
};
