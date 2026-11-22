import { assertPromptResponse } from '../opencode/prompt-response.js';
import { readObjective } from './objectives.js';
import { buildContinuationPrompt } from './continuation.js';
import { createGoalInterruptions, type GoalTick, type PersistSessionGoal } from './interruption.js';
import {
  buildJevAuditRequest,
  smallModelAuditRequest,
  decideProgress,
  readJevAnswers,
  readSmallModelAnswers,
} from './audit.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { isOperatorChildSession, sessionParentId } from '../session-lineage.js';
import { isRecord, isString } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import type { ClassifierEndpoint } from '../routing/classifier.js';
import type { createJevClient } from '../routing/jev.js';
import type { generateSmallModelText } from '../small-model/index.js';
import type { SessionMetadata } from '../openchamber-sessions/session-metadata-store.js';
import type { AuditInput } from './audit.js';
import {
  toLoopMessage, lastUserMessageCreatedAt, messagePartsToText, messageTokenTotal,
  getErrorName, isLengthTruncated, hasRepeatedLengthTail,
} from './messages.js';
import type { LoopMessage, AssistantInfo } from './messages.js';
import {
  readGoalSettings, isSessionGoalEnabled, REASON_CHAR_LIMIT,
  extractSessionStatus, extractAbortedAssistant, extractSessionUpdate, parseGoalMetadata,
} from './goal-state.js';
import type { GoalChecker, SessionGoal, GoalSession, GoalSettlement, SettledGoalStatus } from './goal-state.js';
export { normalizeMaxAutoTurns } from './goal-state.js';
export type { SessionGoal } from './goal-state.js';

interface GoalRuntimeOptions extends Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> {
  getSmallModelService: () => Promise<{ generateSmallModelText: typeof generateSmallModelText }>;
  classifierEndpoint?: () => Promise<ClassifierEndpoint | null>;
  jev?: Pick<ReturnType<typeof createJevClient>, 'ask'> | null;
  getChecker?: () => GoalChecker;
  emitGoalNotification?: (notification: GoalSession & { status: SettledGoalStatus }) => void;
  isEnabled?: () => boolean;
  idleQuietMs?: number;
  kickoffQuietMs?: number;
  recheckMs?: number;
  getMaxAutoTurns?: () => number;
  persistSessionGoal?: PersistSessionGoal | null;
  readSessionMetadata?: ((sessionId: string) => Promise<SessionMetadataInput>) | null;
}

type SessionMetadataInput = SessionMetadata | null | undefined;

export interface SessionGoalRuntime {
  processPayload: (payload: JsonValue | undefined, directoryHint?: string) => void;
  notifyGoalChanged: (sessionId: string, directory: string, metadata: SessionMetadataInput) => Promise<void>;
  recoverActiveGoals: () => Promise<void>; hasLiveWork: () => boolean;
  stop: () => void;
}

interface GoalFetchOptions {
  directory?: string;
  method?: 'GET' | 'POST';
  body?: { text: string };
  query?: Record<string, string>;
}

interface GoalRequestHeaders {
  Accept: string;
  'Content-Type'?: string;
}

type TimerEntry = { timer: ReturnType<typeof setTimeout>; armedAt: number }
  | { timer: null; directory: string; quietMs: number };

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
const isJsonRecord = (value: JsonValue | undefined): value is JsonObject => isRecord(value);
const jsonFields = (value: JsonValue | undefined) => isJsonRecord(value) ? value : undefined;
const isJsonArray = (value: JsonValue | undefined): value is JsonValue[] => Array.isArray(value);
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const hasErrorFields = (value: unknown): value is { message?: unknown; statusCode?: unknown } => value != null;
const errorDetail = (cause: unknown) => (hasErrorFields(cause) ? cause.message : undefined) || cause;

const IDLE_QUIET_MS = 3_000;
const ACTIVITY_RECHECK_MS = 15_000;
const BACKGROUND_SHELL_WAIT_MS = 30 * 60 * 1000;
const RECOVERY_SESSION_LIMIT = 50;
const KICKOFF_QUIET_MS = 3_000;
const RESUME_KICKOFF_MS = 250;
const FETCH_TIMEOUT_MS = 10_000;
const SESSION_READ_RETRIES = 3;
const MESSAGE_FETCH_LIMIT = 40;
const AUDIT_FAIL_LIMIT = 2;

export const createSessionGoalRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  classifierEndpoint = async () => null,
  jev = null,
  getChecker = () => readGoalSettings().checker,
  emitGoalNotification,
  isEnabled = isSessionGoalEnabled,
  idleQuietMs = IDLE_QUIET_MS,
  kickoffQuietMs = KICKOFF_QUIET_MS,
  recheckMs = ACTIVITY_RECHECK_MS,
  getMaxAutoTurns = () => readGoalSettings().maxAutoTurns,
  persistSessionGoal = null,
  readSessionMetadata = null,
}: GoalRuntimeOptions): SessionGoalRuntime => {
  const timers = new Map<string, TimerEntry>();
  const inflight = new Set<string>();
  const readAttempts = new Map<string, GoalTick & { failures: number; activityFailures: number; replyWaits: number }>();
  let stopped = false;
  const interruptions = createGoalInterruptions({
    persistSessionGoal, parseGoalMetadata, recheckMs, onSettled: (sessionId) => rearmPending(sessionId),
  });

  const clearTimer = (sessionId: string) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer ?? undefined);
      timers.delete(sessionId);
    }
  };

  const openCodeFetch = async (fetchPath: string, { directory, method = 'GET', body, query }: GoalFetchOptions = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const url = search ? `${base}?${search}` : base;
    const acceptHeaders: GoalRequestHeaders = { Accept: 'application/json' };
    if (body) acceptHeaders['Content-Type'] = 'application/json';
    const headers = { ...acceptHeaders, ...getOpenCodeAuthHeaders() };
    const requestBody: Pick<RequestInit, 'body'> = {};
    if (body) requestBody.body = JSON.stringify(body);
    const response = await fetch(url, {
      method,
      headers,
      ...requestBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (method === 'POST' && fetchPath.endsWith('/prompt')) {
      await assertPromptResponse(response, 'session.prompt');
    } else if (!response.ok) {
      throw new Error(`OpenCode ${method} ${fetchPath} failed with ${response.status}`);
    }
    const payload: JsonValue = await response.json().catch(() => null);
    return unwrapOpenCodeResponse(payload);
  };

  const fetchRecentMessages = async (sessionId: string, directory: string) => {
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_FETCH_LIMIT) },
    }).catch(() => null);
    const messages = jsonFields(page)?.data;
    if (!isJsonArray(messages)) return null;
    return messages.map(toLoopMessage).filter((message) => message !== null).reverse();
  };

  const activityProbe = createSessionActivityProbe({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  const fetchOwnRunningShells = async (session: JsonObject | JsonValue[], sessionId: string, directory: string) => {
    const location = jsonFields(jsonFields(session)?.location);
    const shellDirectory = isString(location?.directory) && location.directory
      ? location.directory
      : directory;
    const shells = shellDirectory ? await activityProbe.fetchRunningShells(shellDirectory) : null;
    return shells && shells.filter((shell) => shell.sessionID === sessionId);
  };

  const isWorkingStatus = (status: JsonValue | undefined) => Boolean(status);

  const readGoal = async (sessionId: string) => parseGoalMetadata({ metadata: await readSessionMetadata?.(sessionId) });

  const writeGoal = async (sessionId: string, directory: string, expectedGoalId: string,
    mutate: (current: SessionGoal) => Partial<SessionGoal> | null, isCurrent: (() => boolean) | null = null) => {
    const currentGoal = await readGoal(sessionId);
    if (!currentGoal || currentGoal.id !== expectedGoalId) return null;
    const patch = mutate(currentGoal);
    if (!patch) return null;
    const nextGoal = { ...currentGoal, ...patch, updatedAt: Date.now() };
    const canWrite = isCurrent ? (metadata: SessionMetadataInput) => {
      const latest = parseGoalMetadata({ metadata });
      return latest?.id === expectedGoalId && latest.status === 'active' && isCurrent();
    } : null;
    const persisted = await persistSessionGoal?.(sessionId, directory, nextGoal, canWrite);
    if (persisted === false) return null;
    return nextGoal;
  };

  const settleGoal = async ({ sessionId, directory, goal, status, statusReason, tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, evaluationProviderID, evaluationModelID, isCurrent = null }: GoalSettlement) => {
    const written = await writeGoal(sessionId, directory, goal.id, (current) => {
      if (current.status !== 'active' || (isCurrent && !isCurrent())) return null;
      const patch: Partial<SessionGoal> = {
        status,
        statusReason: String(statusReason ?? '').trim().slice(0, REASON_CHAR_LIMIT),
        auditFailStreak: 0,
      };
      if (tokensUsed !== undefined) patch.tokensUsed = tokensUsed;
      if (tokensBaseline !== undefined) patch.tokensBaseline = tokensBaseline;
      if (tokensCommitted !== undefined) patch.tokensCommitted = tokensCommitted;
      if (lastAccountedMessageID) patch.lastAccountedMessageID = lastAccountedMessageID;
      if (evaluationModelID !== undefined) {
        patch.evaluationProviderID = evaluationProviderID ?? '';
        patch.evaluationModelID = evaluationModelID;
      }
      return patch;
    }, isCurrent);
    if (!written) return;
    console.log(`[session-goal] ${sessionId} settled as ${status}${statusReason ? ` (${statusReason})` : ''}`);
    if (isCallable(emitGoalNotification)) {
      try {
        emitGoalNotification({ sessionId, directory, status, goal: written });
      } catch (error) {
        console.warn('[session-goal] notification failed:', errorDetail(error));
      }
    }
  };

  const checkWithJev = async ({ objective, answer, sessionId }: AuditInput & { sessionId: JsonValue }) => {
    const endpoint = await classifierEndpoint();
    if (!endpoint || !jev) return null;
    try {
      const { answers } = await jev.ask(buildJevAuditRequest({ objective, answer }), endpoint);
      const scores = readJevAnswers(answers);
      if (!scores) {
        console.warn('[session-goal] progress check: Jev left a question unanswered', { sessionId });
        return null;
      }
      return { scores, evaluationProviderID: '', evaluationModelID: endpoint.model };
    } catch (error) {
      console.warn('[session-goal] progress check: Jev failed:', errorDetail(error));
      return null;
    }
  };

  const checkWithSmallModel = async ({ objective, answer, directory, lastAssistantInfo }: AuditInput & { directory: string; lastAssistantInfo: AssistantInfo }) => {
    let service;
    try {
      service = await getSmallModelService();
    } catch {
      return null;
    }
    try {
      const generated = await service.generateSmallModelText({
        ...smallModelAuditRequest({ objective, answer }),
        directory,
        sessionID: isString(lastAssistantInfo.sessionID) ? lastAssistantInfo.sessionID : undefined,
        preferredProviderID: isString(lastAssistantInfo.providerID) ? lastAssistantInfo.providerID : undefined,
        preferredModelID: isString(lastAssistantInfo.modelID) ? lastAssistantInfo.modelID : undefined,
      });
      const scores = readSmallModelAnswers(generated?.text);
      if (!scores) {
        console.warn('[session-goal] progress check: small model reply is not the asked-for JSON', {
          sessionId: lastAssistantInfo?.sessionID ?? null,
          provider: generated?.providerID ?? null,
          model: generated?.modelID ?? null,
          outputChars: String(generated?.text ?? '').length,
        });
        return null;
      }
      return { scores, evaluationProviderID: generated.providerID, evaluationModelID: generated.modelID };
    } catch (error) {
      if (Number(hasErrorFields(error) ? error.statusCode : undefined) !== 404) {
        console.warn('[session-goal] progress check: small model failed:', errorDetail(error));
      }
      return null;
    }
  };

  const runAudit = async ({ goal, assistantText, directory, lastAssistantInfo }: { goal: SessionGoal; assistantText: string; directory: string; lastAssistantInfo: AssistantInfo }) => {
    const input = { objective: goal.objective, answer: assistantText };
    const sessionId = lastAssistantInfo?.sessionID ?? null;
    const checked = (getChecker() === 'classifier' ? await checkWithJev({ ...input, sessionId }) : null)
      ?? await checkWithSmallModel({ ...input, directory, lastAssistantInfo });
    if (!checked) return null;
    const verdict = decideProgress(checked.scores);
    console.log('[session-goal:diagnostic] progress check', {
      sessionId,
      model: checked.evaluationModelID || null,
      scores: checked.scores,
      verdict,
    });
    return { verdict, evaluationProviderID: checked.evaluationProviderID, evaluationModelID: checked.evaluationModelID };
  };

  const sendContinuation = async ({ sessionId, directory, goal }: GoalSession) => {
    await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      directory,
      method: 'POST',
      body: { text: buildContinuationPrompt(goal) },
    });
  };

  const tick = async (sessionId: string, directory: string) => {
    if (!isEnabled()) return;
    const maxAutoTurns = getMaxAutoTurns();

    const attempt = readAttempts.get(sessionId) ?? { failures: 0, activityFailures: 0, replyWaits: 0 };
    readAttempts.set(sessionId, attempt);
    interruptions.startTick(sessionId, attempt);
    const isCurrent = () => !stopped && readAttempts.get(sessionId) === attempt;
    const session = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch((cause: unknown) => {
        console.warn(`[session-goal] session fetch failed: ${errorDetail(cause)}`);
        return null;
      });
    if (!isCurrent()) return;
    if (!isObject(session)) {
      attempt.failures += 1;
      if (attempt.failures <= SESSION_READ_RETRIES) {
        armTimer(sessionId, directory, recheckMs * (2 ** (attempt.failures - 1)));
      } else {
        const goal = await readGoal(sessionId);
        if (goal?.status === 'active' && isCurrent()) {
          await settleGoal({
            sessionId, directory, goal, status: 'blocked',
            statusReason: 'Session could not be read after repeated attempts. Resume to try again.',
            isCurrent,
          });
        }
        if (isCurrent()) readAttempts.delete(sessionId);
      }
      return;
    }
    attempt.failures = 0;
    if (sessionParentId(session) && !isOperatorChildSession(session)) return;

    const goal = await readGoal(sessionId);
    if (!isCurrent() || !goal || goal.status !== 'active') return;
    attempt.goalId = goal.id;

    const retryActivity = async () => {
      if (!isCurrent()) return;
      attempt.activityFailures += 1;
      if (attempt.activityFailures <= SESSION_READ_RETRIES) {
        armTimer(sessionId, directory, recheckMs * (2 ** (attempt.activityFailures - 1)));
        return;
      }
      await settleGoal({
        sessionId, directory, goal, status: 'blocked',
        statusReason: 'Session activity could not be read after repeated attempts. Resume to try again.',
        isCurrent,
      });
    };

    const awaitContinuationReply = async () => {
      if (!(goal.auditFailStreak > 0 || goal.statusReason === 'resumed') || !isCurrent()) return;
      attempt.replyWaits += 1;
      if (attempt.replyWaits <= SESSION_READ_RETRIES) {
        armTimer(sessionId, directory, recheckMs * (2 ** (attempt.replyWaits - 1)));
        return;
      }
      await settleGoal({
        sessionId, directory, goal, status: 'blocked',
        statusReason: 'The continuation produced no reply to check. Send a message, or Resume to check again.',
        isCurrent,
      });
    };

    let effectiveObjective = goal.objective;
    if (goal.objectiveFile) {
      const fileObjective = await readObjective(sessionId);
      if (fileObjective) {
        effectiveObjective = fileObjective;
      } else if (!effectiveObjective) {
        console.warn(`[session-goal] ${sessionId} objective file unreadable and no inline fallback`);
        return;
      } else {
        console.warn(`[session-goal] ${sessionId} objective file unreadable, using inline fallback`);
      }
    }

    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!isCurrent()) return;
    if (!statuses) {
      await retryActivity();
      return;
    }
    if (isWorkingStatus(statuses[sessionId])) {
      attempt.activityFailures = 0;
      attempt.replyWaits = 0;
      if (goal.auditFailStreak > 0) armTimer(sessionId, directory, recheckMs);
      return;
    }

    const backgroundJobs = await activityProbe.fetchRunningBackgroundJobs(sessionId);
    if (!isCurrent()) return;
    if (backgroundJobs === null) {
      await retryActivity();
      return;
    }
    const childrenWorking = backgroundJobs?.some((job) => job.kind !== 'shell')
      || await activityProbe.hasWorkingChildren(sessionId, statuses);
    if (!isCurrent()) return;
    if (childrenWorking === null) {
      await retryActivity();
      return;
    }
    if (childrenWorking) {
      attempt.activityFailures = 0;
      armTimer(sessionId, directory, recheckMs);
      return;
    }

    const messages = await fetchRecentMessages(sessionId, directory);
    if (!isCurrent()) return;
    if (!messages) {
      if (goal.auditFailStreak > 0) await retryActivity();
      return;
    }

    let lastAssistant: LoopMessage | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.info?.role === 'assistant') {
        lastAssistant = message;
        break;
      }
    }
    const lastAssistantInfo = lastAssistant?.info.role === 'assistant' ? lastAssistant.info : undefined;
    const lastMessageInfo = messages.length > 0 ? messages[messages.length - 1]?.info : null;

    let executionInfo = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant' && info.summary !== true) {
        executionInfo = info;
        break;
      }
    }

    if (
      lastMessageInfo?.role === 'user'
      || (lastAssistantInfo && !(Number(lastAssistantInfo.time.completed) > 0) && !lastAssistantInfo.error)
    ) {
      await awaitContinuationReply();
      return;
    }

    if (!lastAssistantInfo?.id) return;

    let tokensBaseline = goal.tokensBaseline;
    if (!goal.lastAccountedMessageID && !(tokensBaseline > 0)) {
      tokensBaseline = 0;
      for (const message of messages) {
        const info = message?.info;
        if (info?.role !== 'assistant') continue;
        if (!(Number(info.time.completed) > 0) || Number(info.time.completed) > goal.createdAt) continue;
        tokensBaseline = Math.max(tokensBaseline, messageTokenTotal(info));
      }
    }
    let tokensCommitted = goal.tokensCommitted;
    let tokensUsed = goal.tokensUsed;
    let lastAccountedMessageID = goal.lastAccountedMessageID;
    let segmentSnapshot = null;
    let sawNewMessages = false;
    for (const message of messages) {
      const info = message?.info;
      if (info?.role !== 'assistant') continue;
      if (lastAccountedMessageID && info.id <= lastAccountedMessageID) continue;
      if (!(Number(info.time.completed) > 0)) continue;
      sawNewMessages = true;
      const total = messageTokenTotal(info);
      if (info.summary === true) {
        tokensCommitted = Math.max(
          goal.tokensUsed,
          tokensCommitted + Math.max(0, (segmentSnapshot ?? 0) - tokensBaseline),
        );
        tokensBaseline = 0;
        segmentSnapshot = null;
      } else {
        segmentSnapshot = total;
      }
      if (!lastAccountedMessageID || info.id > lastAccountedMessageID) {
        lastAccountedMessageID = info.id;
      }
    }
    if (sawNewMessages) {
      const segmentCurrent = segmentSnapshot !== null ? Math.max(0, segmentSnapshot - tokensBaseline) : 0;
      tokensUsed = Math.max(goal.tokensUsed, tokensCommitted + segmentCurrent);
    }

    const assistantText = messagePartsToText(lastAssistant);

    if (goal.statusReason !== 'resumed' && !lastAssistantInfo.error) {
      const jobs = backgroundJobs && await activityProbe.fetchRunningBackgroundJobs(sessionId);
      const shells = backgroundJobs
        ? jobs && jobs.filter((job) => job.kind === 'shell')
        : await fetchOwnRunningShells(session, sessionId, directory);
      if (!isCurrent()) return;
      if (!shells) {
        await retryActivity();
        return;
      }
      attempt.activityFailures = 0;
      if (jobs?.some((job) => job.kind !== 'shell')) {
        armTimer(sessionId, directory, recheckMs);
        return;
      }
      const roundStartedAt = lastUserMessageCreatedAt(messages, goal.createdAt);
      const waitingOn = shells.filter((shell) => shell.startedAt >= roundStartedAt);
      const stillWaiting = waitingOn.some((shell) => Date.now() - shell.startedAt < BACKGROUND_SHELL_WAIT_MS);
      if (stillWaiting) {
        armTimer(sessionId, directory, recheckMs);
        return;
      }
    }


    const error = lastAssistantInfo.error;
    const errorName = getErrorName(error);
    const hasError = error !== null && error !== undefined;
    const abortedTail = errorName === 'aborted' || errorName === 'MessageAbortedError';
    const lengthTail = isLengthTruncated(lastAssistantInfo, { errorName });
    if (abortedTail && goal.statusReason !== 'resumed') {
      const paused = await writeGoal(sessionId, directory, goal.id, () => ({
        status: 'paused',
        statusReason: 'paused after abort',
        tokensUsed,
        tokensBaseline,
        tokensCommitted,
        lastAccountedMessageID,
      }), isCurrent);
      if (paused) console.log(`[session-goal] ${sessionId} paused after user abort`);
      return;
    }

    if (!abortedTail && !lengthTail && hasError) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: errorName || 'assistant turn failed', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, isCurrent,
      });
      return;
    }

    if (goal.tokenBudget !== null && tokensUsed >= goal.tokenBudget) {
      await settleGoal({
        sessionId, directory, goal, status: 'budgetLimited', statusReason: 'token budget reached', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, isCurrent,
      });
      return;
    }

    if (goal.turnsUsed >= maxAutoTurns) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: 'auto-continuation limit reached', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, isCurrent,
      });
      return;
    }

    if (lengthTail && goal.statusReason !== 'resumed' && hasRepeatedLengthTail(messages, lastAssistant, goal.createdAt)) {
      await settleGoal({
        sessionId, directory, goal, status: 'blocked', statusReason: 'repeated output truncation', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, isCurrent,
      });
      return;
    }

    let audit = null;
    let auditFailStreak = goal.auditFailStreak;
    if (!(lastAssistantInfo.summary === true || abortedTail || lengthTail)) {
      audit = await runAudit({ goal: { ...goal, objective: effectiveObjective }, assistantText, directory, lastAssistantInfo: executionInfo ?? lastAssistantInfo });
      if (!isCurrent()) return;

      if (!audit) {
        auditFailStreak += 1;
        if (auditFailStreak >= AUDIT_FAIL_LIMIT) {
          await settleGoal({
            sessionId, directory, goal, status: 'blocked', statusReason: 'progress audit unavailable', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID, isCurrent,
          });
          return;
        }
        console.warn(`[session-goal] ${sessionId} progress check unavailable, continuing unchecked (${auditFailStreak}/${AUDIT_FAIL_LIMIT})`);
      } else {
        auditFailStreak = 0;
      }

      if (audit?.verdict === 'complete') {
        await settleGoal({
          sessionId, directory, goal, status: 'complete', statusReason: 'verified by audit', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
          evaluationProviderID: audit.evaluationProviderID, evaluationModelID: audit.evaluationModelID, isCurrent,
        });
        return;
      }

      if (audit?.verdict === 'blocked') {
        await settleGoal({
          sessionId, directory, goal, status: 'blocked', statusReason: 'waiting for user input', tokensUsed, tokensBaseline, tokensCommitted, lastAccountedMessageID,
          evaluationProviderID: audit.evaluationProviderID, evaluationModelID: audit.evaluationModelID, isCurrent,
        });
        return;
      }
    }

    const written = await writeGoal(sessionId, directory, goal.id, (current) => {
      if (current.status !== 'active' || !isCurrent()) return null;
      const patch: Partial<SessionGoal> = {
        tokensUsed,
        tokensBaseline,
        tokensCommitted,
        lastAccountedMessageID,
        turnsUsed: current.turnsUsed + 1,
        auditFailStreak,
        statusReason: '',
      };
      if (audit) {
        patch.evaluationProviderID = audit.evaluationProviderID ?? '';
        patch.evaluationModelID = audit.evaluationModelID ?? '';
      }
      return patch;
    }, isCurrent);
    if (!written) {
      console.log('[session-goal] goal changed during tick, dropping continuation');
      return;
    }

    try {
      await interruptions.sendReserved({
        sessionId, directory, written, attempt, isCurrent,
        confirmTail: async () => {
          const latest = await fetchRecentMessages(sessionId, directory);
          const tail = latest?.at(-1)?.info;
          return Boolean(tail && tail.id === lastMessageInfo?.id);
        },
        send: () => {
          console.log(`[session-goal] continuing ${sessionId} (turn ${written.turnsUsed}/${maxAutoTurns}, tokens ${written.tokensUsed}${written.tokenBudget ? `/${written.tokenBudget}` : ''})`);
          return sendContinuation({ sessionId, directory, goal: { ...written, objective: effectiveObjective } });
        },
      });
    } finally {
      if (auditFailStreak > 0 && isCurrent()) armTimer(sessionId, directory, recheckMs);
    }
  };

  const rearmPending = (sessionId: string) => {
    const pending = timers.get(sessionId);
    if (pending && !pending.timer && !inflight.has(sessionId) && !interruptions.hasPending(sessionId)) armTimer(sessionId, pending.directory, pending.quietMs);
  };
  const finishInflight = (sessionId: string) => {
    inflight.delete(sessionId);
    interruptions.finishTick(sessionId);
    if (timers.has(sessionId)) rearmPending(sessionId);
    else readAttempts.delete(sessionId);
  };

  const armTimer = (sessionId: string, directory: string, quietMs: number) => {
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      if (stopped) return;
      if (inflight.has(sessionId) || interruptions.hasPending(sessionId)) {
        timers.set(sessionId, { timer: null, directory, quietMs });
        return;
      }
      timers.delete(sessionId);
      inflight.add(sessionId);
      tick(sessionId, directory)
        .catch((cause: unknown) => {
          console.warn('[session-goal] tick failed:', errorDetail(cause));
        })
        .finally(() => {
          finishInflight(sessionId);
        });
    }, quietMs);
    if (isCallable(timer?.unref)) timer.unref();
    timers.set(sessionId, { timer, armedAt: Date.now() });
  };

  const isWired = () => isCallable(persistSessionGoal) && isCallable(readSessionMetadata);

  const notifyGoalChanged: SessionGoalRuntime['notifyGoalChanged'] = async (sessionId, directory, metadata) => {
    if (stopped || !isWired()) return;
    const goal = parseGoalMetadata({ metadata });
    interruptions.notifyGoalChanged(sessionId, goal);
    if (!goal || goal.status !== 'active') {
      interruptions.cancelPause(sessionId);
      readAttempts.delete(sessionId);
      clearTimer(sessionId);
      return;
    }
    if (goal.turnsUsed !== 0 && goal.statusReason !== 'resumed') return;
    interruptions.cancelPause(sessionId);
    readAttempts.delete(sessionId);
    clearTimer(sessionId);

    let resolved = directory;
    if (!resolved) {
      const session = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`).catch(() => null);
      const location = jsonFields(jsonFields(session)?.location);
      resolved = isString(location?.directory) ? location.directory : '';
    }
    if (stopped || timers.has(sessionId)) return;
    armTimer(sessionId, resolved, goal.statusReason === 'resumed' ? RESUME_KICKOFF_MS : kickoffQuietMs);
  };

  const recoverActiveGoals = async () => {
    if (stopped || !isWired() || !isEnabled()) return;
    const page = await openCodeFetch('/api/session', {
      query: { parentID: 'null', archived: 'false', order: 'desc', limit: String(RECOVERY_SESSION_LIMIT) },
    }).catch((cause: unknown) => {
      console.warn('[session-goal] recovery: session list failed:', errorDetail(cause));
      return null;
    });
    const data = jsonFields(page)?.data;
    const sessions = isJsonArray(data) ? data : [];
    for (const record of sessions) {
      if (stopped) return;
      const session = jsonFields(record);
      const sessionId = isString(session?.id) ? session.id : '';
      if (!sessionId || timers.has(sessionId) || inflight.has(sessionId)) continue;
      if (parseGoalMetadata(session)?.status !== 'active') continue;
      const location = jsonFields(session?.location);
      const directory = isString(location?.directory) ? location.directory : '';
      armTimer(sessionId, directory, kickoffQuietMs);
    }
  };

  let parkedNoticeLogged = false;
  const processPayload: SessionGoalRuntime['processPayload'] = (rawPayload, directoryHint = '') => {
    if (stopped) return;
    if (!isWired()) {
      if (!parkedNoticeLogged) {
        parkedNoticeLogged = true;
        console.log('[session-goal] parked: no session metadata store is wired, so goal progress cannot be saved');
      }
      return;
    }

    const payload = jsonFields(rawPayload);
    const aborted = extractAbortedAssistant(payload);
    if (aborted && !interruptions.isSupersededStop(aborted.sessionId)) {
      readAttempts.delete(aborted.sessionId);
      clearTimer(aborted.sessionId);
      interruptions.pause(aborted.sessionId, directoryHint);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      interruptions.notifyStatus(status.sessionId, status.type);
      readAttempts.delete(status.sessionId);
      const statusDirectory = status.directory || directoryHint;
      if (status.type === 'idle') {
        armTimer(status.sessionId, statusDirectory, idleQuietMs);
        return;
      }
      clearTimer(status.sessionId);
      void readGoal(status.sessionId)
        .then((goal) => {
          if (stopped || goal?.status !== 'active' || !(goal.auditFailStreak > 0)) return;
          if (timers.has(status.sessionId)) return;
          armTimer(status.sessionId, statusDirectory, recheckMs);
        })
        .catch(() => undefined);
      return;
    }

    const update = extractSessionUpdate(payload);
    if (update && !update.parentID && !timers.has(update.sessionId) && !inflight.has(update.sessionId)) {
      void readGoal(update.sessionId)
        .then((goal) => {
          if (stopped || !goal || goal.status !== 'active') return;
          if (goal.turnsUsed !== 0 && goal.statusReason !== 'resumed') return;
          if (timers.has(update.sessionId) || inflight.has(update.sessionId)) return;
          armTimer(
            update.sessionId,
            update.directory || directoryHint,
            goal.statusReason === 'resumed' ? RESUME_KICKOFF_MS : kickoffQuietMs,
          );
        })
        .catch(() => undefined);
    }
  };

  const stop = () => {
    stopped = true;
    for (const { timer } of timers.values()) {
      clearTimeout(timer ?? undefined);
    }
    timers.clear();
    readAttempts.clear();
    interruptions.stop();
  };

  return { processPayload, notifyGoalChanged, recoverActiveGoals, hasLiveWork: () => inflight.size > 0 || timers.size > 0, stop };
};
