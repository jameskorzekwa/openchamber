import { createHash } from 'node:crypto';

import {
  clearManagedGoalRecoveryState,
  listManagedGoalRecoveryRoots,
  readManagedGoalRecoveryState,
  writeManagedGoalRecoveryState,
} from './managed-goal-recovery-state.js';

const DEFAULT_STALE_MS = 15 * 60 * 1_000;
const DEFAULT_POLL_MS = 60 * 1_000;
const DEFAULT_DISCOVERY_MS = 5 * 60 * 1_000;
const SESSION_TREE_LIMIT = 1_000;
const HELD_STATUS_REASONS = new Set(['worktree-moving', 'worktree-resume-dispatching']);
const RECOVERY_REASON_PREFIX = 'stale-recovery:';
const RECOVERY_TASK_ERROR = 'Task outcome is unknown because OpenCode restarted during foreground execution.';

const DEFAULT_MAX_ABORT_ATTEMPTS = 5;
const DEFAULT_MAX_AUTO_TURNS = 20;
const DEFAULT_INITIAL_BACKOFF_MS = 60 * 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1_000;
const isText = (value) => String(value) === value;
const isRecord = (value) => value?.constructor === Object;

const goalFrom = (session) => session?.metadata?.openchamber?.goal;

const isActiveManagedGoal = (session) => {
  const goal = goalFrom(session);
  if (goal?.managedWorktree !== true || goal.status !== 'active') return false;
  if (HELD_STATUS_REASONS.has(goal.statusReason)) return false;
  return isText(goal.id) && Boolean(goal.id);
};

const messageActivity = (session, message) => {
  const values = [
    session?.time?.created,
    session?.time?.updated,
    message?.info?.time?.created,
    message?.info?.time?.completed,
  ];
  for (const part of message?.parts ?? []) {
    values.push(
      part?.time?.created,
      part?.time?.completed,
      part?.time?.start,
      part?.time?.end,
      part?.state?.time?.start,
      part?.state?.time?.end,
    );
  }
  return values.reduce((latest, value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, 0);
};

const incompleteAssistant = (message) => (
  message?.info?.role === 'assistant'
  && !(message.info.time?.completed > 0)
  && !message.info.error
);

const terminalAssistant = (message) => Boolean(
  message?.info?.role === 'assistant'
  && (message.info.error || message.info.time?.completed > 0)
);

const pendingTools = (message) => (message?.parts ?? []).filter((part) => (
  part?.type === 'tool' && !['completed', 'error'].includes(part?.state?.status)
));

const taskChildId = (part) => {
  if (part?.tool !== 'task' || part?.state?.status !== 'running') return '';
  const metadata = part.state?.metadata;
  return isText(metadata?.sessionId) ? metadata.sessionId : '';
};

const sessionList = (payload) => {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.data) ? payload.data : [];
};

const recoveryMessageId = (state) => {
  const key = [
    state.goalId,
    state.rootId,
    state.target.sessionId,
    state.target.messageId,
    state.target.taskPartId,
    state.target.taskCallId,
  ].join(':');
  return `msg_recovery_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
};

const recoveryReason = (messageId) => `${RECOVERY_REASON_PREFIX}${messageId}`;

const textFrom = (message) => (message?.parts ?? [])
  .filter((part) => part?.type === 'text' && isText(part.text))
  .map((part) => part.text)
  .join('\n');

export const createManagedGoalStaleRecovery = ({
  openCodeFetch,
  buildRecoveryPrompt = async () => 'OpenCode restarted during the prior turn. Reinspect the current workspace and continue the active session goal.',
  staleMs = DEFAULT_STALE_MS,
  pollMs = DEFAULT_POLL_MS,
  discoveryMs = DEFAULT_DISCOVERY_MS,
  maxAbortAttempts = DEFAULT_MAX_ABORT_ATTEMPTS,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  deliveryBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxDeliveryAttempts = DEFAULT_MAX_ABORT_ATTEMPTS,
  maxAutoTurns = DEFAULT_MAX_AUTO_TURNS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  isEnabled = () => true,
  logger = console,
  stateDirectory,
} = {}) => {
  if (!openCodeFetch) throw new TypeError('openCodeFetch is required');

  const roots = new Map();
  const stateOptions = stateDirectory ? { stateDirectory } : {};
  let scanTimer = null;
  let discoveryTimer = null;
  let scanning = null;
  let discovering = null;

  const saveState = (state) => writeManagedGoalRecoveryState(state, stateOptions);
  const clearState = (rootId) => clearManagedGoalRecoveryState(rootId, stateOptions);

  const observe = (update) => {
    if (!update || update.parentID || !isText(update.sessionId) || !update.sessionId) return;
    if (
      update.goal?.managedWorktree === true
      && update.goal?.status === 'active'
      && !HELD_STATUS_REASONS.has(update.goal?.statusReason)
    ) {
      roots.set(update.sessionId, update.directory || '');
    } else {
      roots.delete(update.sessionId);
    }
  };

  const discoverNow = async () => {
    if (discovering) return discovering;
    discovering = (async () => {
      if (!isEnabled()) return;
      for (const rootId of await listManagedGoalRecoveryRoots(stateOptions)) {
        roots.set(rootId, '');
        try {
          const state = await readManagedGoalRecoveryState(rootId, stateOptions);
          if (state) roots.set(rootId, state.directory);
        } catch (error) {
          logger.warn('[session-goal] invalid recovery state preserved for inspection:', {
            rootId,
            error: error?.message || error,
          });
        }
      }
      const payload = await openCodeFetch('/experimental/session', {
        query: { archived: 'true', limit: '10000' },
      });
      for (const session of sessionList(payload)) {
        if (session?.parentID || !isText(session?.id)) continue;
        if (isActiveManagedGoal(session)) {
          roots.set(session.id, session.directory || '');
          continue;
        }
        try {
          if (!await readManagedGoalRecoveryState(session.id, stateOptions)) roots.delete(session.id);
        } catch {
          roots.set(session.id, session.directory || '');
        }
      }
    })().catch((error) => {
      logger.warn('[session-goal] stale recovery discovery failed:', error?.message || error);
    }).finally(() => {
      discovering = null;
    });
    return discovering;
  };

  const messages = async (sessionId, directory, limit = '40') => {
    const result = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit },
    });
    if (!Array.isArray(result)) throw new Error(`invalid message response for ${sessionId}`);
    return result;
  };

  const latestMessage = async (sessionId, directory) => (await messages(sessionId, directory, '1')).at(-1) ?? null;

  const fetchTree = async (root, directory) => {
    const tree = new Map([[root.id, root]]);
    const pending = [root.id];
    while (pending.length > 0) {
      const sessionId = pending.shift();
      const children = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/children`, { directory });
      if (!Array.isArray(children)) throw new Error(`invalid child session response for ${sessionId}`);
      for (const child of children) {
        if (!isText(child?.id) || tree.has(child.id)) continue;
        if (tree.size >= SESSION_TREE_LIMIT) throw new Error('managed goal session tree exceeded safety limit');
        tree.set(child.id, child);
        pending.push(child.id);
      }
    }
    return tree;
  };

  const inspectRoot = async (rootId, directoryHint, expectedGoalId = '') => {
    const root = await openCodeFetch(`/session/${encodeURIComponent(rootId)}`, { directory: directoryHint });
    const goal = goalFrom(root);
    const ownedPause = goal?.status === 'paused' && goal?.statusReason === 'paused after abort';
    const ownedHold = goal?.status === 'active' && goal?.statusReason?.startsWith(RECOVERY_REASON_PREFIX);
    const active = isActiveManagedGoal(root);
    if (root?.parentID || goal?.managedWorktree !== true || (!active && !ownedPause && !ownedHold)) return null;
    if (expectedGoalId && goal.id !== expectedGoalId) return null;
    const directory = root.directory || directoryHint;
    if (!directory || (directoryHint && directory !== directoryHint)) return null;

    const statuses = await openCodeFetch('/session/status', { directory });
    if (!isRecord(statuses)) {
      throw new Error('managed goal session status is unavailable');
    }
    const tree = await fetchTree(root, directory);
    let blocked = false;
    for (const session of tree.values()) {
      if (session.directory && session.directory !== directory) return null;
      if (['busy', 'retry'].includes(statuses[session.id]?.type)) blocked = true;
    }
    return { root, goal, directory, statuses, tree, blocked };
  };

  const exactTaskBinding = (message, taskPartId, taskCallId, childSessionId) => {
    const part = (message?.parts ?? []).find((candidate) => candidate?.id === taskPartId);
    if (!part || part.tool !== 'task') return null;
    if (taskCallId && part.callID !== taskCallId) return null;
    const linkedChild = part?.state?.metadata?.sessionId;
    return linkedChild === childSessionId ? part : null;
  };

  const validateStateEvidence = async (state) => {
    const inspected = await inspectRoot(state.rootId, state.directory, state.goalId);
    if (!inspected || !inspected.tree.has(state.target.sessionId)) return null;
    if (inspected.blocked) return { ...inspected, blocked: true };

    const latestBySession = new Map();
    for (const session of inspected.tree.values()) {
      latestBySession.set(session.id, await latestMessage(session.id, inspected.directory));
    }
    const targetMessage = latestBySession.get(state.target.sessionId);
    if (targetMessage?.info?.id !== state.target.messageId) return null;

    let taskPart = null;
    if (state.target.taskPartId) {
      const parent = inspected.tree.get(state.target.parentSessionId);
      if (!parent || parent.id !== state.rootId) return null;
      const parentMessage = latestBySession.get(parent.id);
      if (parentMessage?.info?.id !== state.target.parentMessageId) return null;
      taskPart = exactTaskBinding(
        parentMessage,
        state.target.taskPartId,
        state.target.taskCallId,
        state.target.taskChildSessionId,
      );
      if (!taskPart) return null;
    }

    for (const [sessionId, message] of latestBySession) {
      const pending = pendingTools(message);
      const allowedTask = state.target.taskPartId && sessionId === state.target.parentSessionId
        ? pending.filter((part) => part.id === state.target.taskPartId)
        : [];
      if (pending.length !== allowedTask.length) return { ...inspected, blocked: true };
      if (
        sessionId !== state.target.sessionId
        && sessionId !== state.rootId
        && incompleteAssistant(message)
      ) return { ...inspected, blocked: true };
    }

    return { ...inspected, latestBySession, targetMessage, taskPart };
  };

  const clearRecoveryHold = async (state) => {
    const session = await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, { directory: state.directory });
    const goal = goalFrom(session);
    if (goal?.id !== state.goalId || goal.status !== 'active' || goal.statusReason !== recoveryReason(state.deliveryMessageId)) return;
    const metadata = isRecord(session?.metadata) ? session.metadata : {};
    const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, {
      directory: state.directory,
      method: 'PATCH',
      body: { metadata: { ...metadata, openchamber: { ...namespace, goal: { ...goal, statusReason: '', updatedAt: now() } } } },
    });
  };

  const abandonState = async (state) => {
    await clearRecoveryHold(state).catch(() => {});
    await clearState(state.rootId);
  };

  const terminalizeRecovery = async (state, status, statusReason) => {
    const session = await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, { directory: state.directory });
    const goal = goalFrom(session);
    if (goal?.id !== state.goalId) return false;
    if (goal.status === status && goal.statusReason === statusReason) {
      await clearState(state.rootId);
      return true;
    }
    const owned = (
      goal.status === 'paused' && goal.statusReason === 'paused after abort'
    ) || (
      goal.status === 'active'
      && (!goal.statusReason || goal.statusReason === recoveryReason(state.deliveryMessageId))
    );
    if (!owned) return false;
    const metadata = isRecord(session?.metadata) ? session.metadata : {};
    const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, {
      directory: state.directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...metadata,
          openchamber: {
            ...namespace,
            goal: { ...goal, status, statusReason, updatedAt: now() },
          },
        },
      },
    });
    const written = await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, { directory: state.directory });
    const writtenGoal = goalFrom(written);
    if (writtenGoal?.id !== state.goalId || writtenGoal.status !== status || writtenGoal.statusReason !== statusReason) {
      return false;
    }
    await clearState(state.rootId);
    logger.warn('[session-goal] stale recovery stopped before continuation', {
      rootId: state.rootId,
      status,
      statusReason,
    });
    return true;
  };

  const hardContinuationStop = (goal) => {
    if (Number.isFinite(goal.tokenBudget) && goal.tokensUsed >= goal.tokenBudget) {
      return { status: 'budgetLimited', statusReason: 'token budget reached' };
    }
    if (goal.turnsUsed >= maxAutoTurns) {
      return { status: 'blocked', statusReason: 'auto-continuation limit reached' };
    }
    return null;
  };

  const reconcileTask = async (state, evidence) => {
    if (!state.target.taskPartId) return true;
    const part = evidence.taskPart;
    if (!part) return false;
    if (part.state?.status === 'error' && part.state?.metadata?.interrupted === true) return true;
    if (part.state?.status !== 'running') return false;
    const end = now();
    const metadata = isRecord(part.state?.metadata) ? part.state.metadata : {};
    const next = {
      ...part,
      state: {
        ...part.state,
        status: 'error',
        error: RECOVERY_TASK_ERROR,
        metadata: { ...metadata, interrupted: true },
        time: { ...(part.state?.time ?? {}), end },
      },
    };
    await openCodeFetch(
      `/session/${encodeURIComponent(state.target.parentSessionId)}/message/${encodeURIComponent(state.target.parentMessageId)}/part/${encodeURIComponent(state.target.taskPartId)}`,
      { directory: state.directory, method: 'PATCH', body: next },
    );
    const parentMessage = await openCodeFetch(
      `/session/${encodeURIComponent(state.target.parentSessionId)}/message/${encodeURIComponent(state.target.parentMessageId)}`,
      { directory: state.directory },
    );
    const written = exactTaskBinding(
      parentMessage,
      state.target.taskPartId,
      state.target.taskCallId,
      state.target.taskChildSessionId,
    );
    return written?.state?.status === 'error'
      && written.state.error === RECOVERY_TASK_ERROR
      && written.state.metadata?.interrupted === true;
  };

  const prepareDelivery = async (state, evidence) => {
    const rootMessage = evidence.latestBySession.get(state.rootId);
    if (!rootMessage?.info?.id || rootMessage.info.role !== 'assistant') return null;
    const goal = goalFrom(evidence.root);
    const marker = recoveryReason(state.deliveryMessageId);
    if (goal.status === 'paused' && goal.statusReason !== 'paused after abort') return null;
    if (goal.status === 'active' && goal.statusReason && goal.statusReason !== marker) return null;
    if (goal.status === 'active' && goal.statusReason === marker) return goal;
    const metadata = isRecord(evidence.root?.metadata) ? evidence.root.metadata : {};
    const namespace = isRecord(metadata.openchamber) ? metadata.openchamber : {};
    const nextGoal = {
      ...goal,
      status: 'active',
      statusReason: marker,
      turnsUsed: (Number.isFinite(goal.turnsUsed) ? goal.turnsUsed : 0) + 1,
      updatedAt: now(),
    };
    await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, {
      directory: state.directory,
      method: 'PATCH',
      body: { metadata: { ...metadata, openchamber: { ...namespace, goal: nextGoal } } },
    });
    return nextGoal;
  };

  const findDelivery = async (state) => {
    const recent = await messages(state.rootId, state.directory);
    return recent.find((message) => message?.info?.id === state.deliveryMessageId) ?? null;
  };

  const finishDelivery = async (state, delivered) => {
    const deliveredText = textFrom(delivered);
    if (delivered?.info?.role === 'user' && !deliveredText) return false;
    if (delivered?.info?.role !== 'user' || deliveredText !== state.deliveryPrompt) {
      logger.warn('[session-goal] stale recovery message identity collision; refusing continuation', {
        rootId: state.rootId,
        messageId: state.deliveryMessageId,
      });
      if (!await terminalizeRecovery(state, 'blocked', 'stale recovery message identity collision')) {
        await abandonState(state);
      }
      return true;
    }
    await clearRecoveryHold(state);
    await clearState(state.rootId);
    logger.warn('[session-goal] recovered stale managed-goal with verified continuation', {
      rootId: state.rootId,
      sessionId: state.target.sessionId,
      messageId: state.deliveryMessageId,
    });
    return true;
  };

  const deliver = async (state) => {
    const existing = await findDelivery(state);
    if (existing) {
      await finishDelivery(state, existing);
      return;
    }
    if (state.deliveryAttempts >= maxDeliveryAttempts) {
      logger.warn('[session-goal] stale recovery continuation exhausted; blocking managed goal', {
        rootId: state.rootId,
        messageId: state.deliveryMessageId,
        attempts: state.deliveryAttempts,
      });
      if (!await terminalizeRecovery(state, 'blocked', 'stale recovery continuation delivery exhausted')) {
        await abandonState(state);
      }
      return;
    }
    const deliveryDelay = Math.min(
      deliveryBackoffMs * 2 ** Math.max(0, state.deliveryAttempts - 1),
      maxBackoffMs,
    );
    if (state.deliveryAttemptedAt && now() - state.deliveryAttemptedAt < deliveryDelay) return;

    const evidence = await validateStateEvidence(state);
    if (!evidence) {
      await abandonState(state);
      return;
    }
    if (evidence.blocked) return;
    if (!await reconcileTask(state, evidence)) {
      await abandonState(state);
      return;
    }

    const refreshed = await validateStateEvidence(state);
    if (!refreshed) {
      await abandonState(state);
      return;
    }
    if (refreshed.blocked) return;
    const hardStop = hardContinuationStop(goalFrom(refreshed.root));
    if (hardStop) {
      if (!await terminalizeRecovery(state, hardStop.status, hardStop.statusReason)) {
        await abandonState(state);
      }
      return;
    }
    const writtenGoal = await prepareDelivery(state, refreshed);
    if (!writtenGoal) {
      await abandonState(state);
      return;
    }

    const finalEvidence = await validateStateEvidence(state);
    if (!finalEvidence) {
      await abandonState(state);
      return;
    }
    if (finalEvidence.blocked) return;
    const source = finalEvidence.latestBySession.get(state.rootId)?.info;
    const providerID = isText(source?.providerID) ? source.providerID : '';
    const modelID = isText(source?.modelID) ? source.modelID : '';
    if (!providerID || !modelID) return;
    const agent = isText(source.agent) && source.agent
      ? source.agent
      : (isText(source.mode) ? source.mode : '');
    const variant = isText(source.variant) ? source.variant : '';

    const attempted = {
      ...state,
      deliveryAttemptedAt: now(),
      deliveryAttempts: state.deliveryAttempts + 1,
    };
    await saveState(attempted);
    const body = {
      messageID: state.deliveryMessageId,
      model: { providerID, modelID },
      parts: [{ type: 'text', text: state.deliveryPrompt }],
    };
    if (agent) body.agent = agent;
    if (variant) body.variant = variant;
    await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}/prompt_async`, {
      directory: state.directory,
      method: 'POST',
      body,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(100);
      const delivered = await findDelivery(state);
      if (delivered) {
        if (await finishDelivery(state, delivered)) return;
      }
    }
  };

  const transitionToDelivery = async (state, evidence) => {
    const deliveryMessageId = recoveryMessageId(state);
    const deliveryPrompt = await buildRecoveryPrompt({
      rootId: state.rootId,
      directory: state.directory,
      goal: goalFrom(evidence.root),
    });
    const next = {
      ...state,
      phase: 'delivery',
      deliveryMessageId,
      deliveryPrompt: String(deliveryPrompt),
      deliveryAttemptedAt: 0,
      deliveryAttempts: 0,
    };
    await saveState(next);
    await deliver(next);
  };

  const waitForAbortPause = async (state) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(100);
      const session = await openCodeFetch(`/session/${encodeURIComponent(state.rootId)}`, {
        directory: state.directory,
      });
      const goal = goalFrom(session);
      if (goal?.id !== state.goalId) return false;
      if (goal.status === 'paused') return goal.statusReason === 'paused after abort';
    }
    return true;
  };

  const continueAfterTerminalAbort = async (state) => {
    if (state.target.sessionId !== state.rootId) {
      await clearState(state.rootId);
      logger.warn('[session-goal] recovered stale managed-goal child model stream', {
        rootId: state.rootId,
        sessionId: state.target.sessionId,
      });
      return;
    }
    if (!await waitForAbortPause(state)) {
      await abandonState(state);
      return;
    }
    const refreshed = await validateStateEvidence(state);
    if (refreshed && !refreshed.blocked) await transitionToDelivery(state, refreshed);
  };

  const attemptAbort = async (state) => {
    if (state.attempts < maxAbortAttempts && now() < state.nextAttemptAt) return;
    const evidence = await validateStateEvidence(state);
    if (!evidence) {
      await abandonState(state);
      return;
    }
    if (evidence.blocked) return;
    if (!incompleteAssistant(evidence.targetMessage)) {
      if (terminalAssistant(evidence.targetMessage)) {
        await continueAfterTerminalAbort(state);
      } else {
        await abandonState(state);
      }
      return;
    }

    if (state.attempts >= maxAbortAttempts) {
      await transitionToDelivery(state, evidence);
      return;
    }

    const attempts = state.attempts + 1;
    const backoff = Math.min(initialBackoffMs * 2 ** (attempts - 1), maxBackoffMs);
    const attempted = { ...state, attempts, nextAttemptAt: now() + backoff };
    await saveState(attempted);
    try {
      await openCodeFetch(`/session/${encodeURIComponent(state.target.sessionId)}/abort`, {
        directory: state.directory,
        method: 'POST',
      });
    } catch (error) {
      logger.warn('[session-goal] stale recovery abort failed; will retry', {
        rootId: state.rootId,
        sessionId: state.target.sessionId,
        attempt: attempts,
        error: error?.message || error,
      });
      return;
    }

    const postAbortMessage = await latestMessage(state.target.sessionId, state.directory);
    if (terminalAssistant(postAbortMessage) && postAbortMessage.info.id === state.target.messageId) {
      await continueAfterTerminalAbort(attempted);
      return;
    }

    if (attempts >= maxAbortAttempts) {
      logger.warn('[session-goal] abort exhausted; reconciling preserved unknown outcome', {
        rootId: state.rootId,
        sessionId: state.target.sessionId,
        messageId: state.target.messageId,
        attempts,
      });
      const refreshed = await validateStateEvidence(attempted);
      if (refreshed && !refreshed.blocked) await transitionToDelivery(attempted, refreshed);
      return;
    }
    logger.warn('[session-goal] abort did not settle stale stream; will retry', {
      rootId: state.rootId,
      sessionId: state.target.sessionId,
      messageId: state.target.messageId,
      attempt: attempts,
    });
  };

  const taskBinding = (rootPendingTools, childId) => {
    const matches = rootPendingTools.filter((part) => taskChildId(part) === childId);
    return matches.length === 1 ? matches[0] : null;
  };

  const newState = ({ rootId, goalId, directory, sessionId, messageId, taskPart, taskChildSessionId, parentMessageId }) => ({
    version: 1,
    rootId,
    goalId,
    directory,
    target: {
      sessionId,
      messageId,
      taskPartId: taskPart?.id || '',
      taskCallId: taskPart?.callID || '',
      taskChildSessionId: taskChildSessionId || '',
      parentSessionId: taskPart ? rootId : '',
      parentMessageId: taskPart ? parentMessageId : '',
    },
    attempts: 0,
    nextAttemptAt: 0,
    phase: 'aborting',
    deliveryMessageId: '',
    deliveryPrompt: '',
    deliveryAttemptedAt: 0,
    deliveryAttempts: 0,
  });

  const checkRoot = async (rootId, directoryHint) => {
    const durable = await readManagedGoalRecoveryState(rootId, stateOptions);
    if (durable) {
      if (durable.phase === 'delivery') await deliver(durable);
      else await attemptAbort(durable);
      return;
    }

    const inspected = await inspectRoot(rootId, directoryHint);
    if (!inspected || !isActiveManagedGoal(inspected.root)) {
      roots.delete(rootId);
      return;
    }
    roots.set(rootId, inspected.directory);
    if (inspected.blocked) return;

    const rootMessage = await latestMessage(rootId, inspected.directory);
    const rootPendingTools = pendingTools(rootMessage);
    const children = [...inspected.tree.values()].filter((session) => session.id !== rootId);
    for (const child of children) {
      if (child.parentID !== rootId) continue;
      const childMessage = await latestMessage(child.id, inspected.directory);
      if (!incompleteAssistant(childMessage)) continue;
      const binding = taskBinding(rootPendingTools, child.id);
      if (!binding || rootPendingTools.length !== 1 || pendingTools(childMessage).length > 0) continue;
      const activity = messageActivity(child, childMessage);
      if (!activity || now() - activity < staleMs) continue;
      const state = newState({
        rootId,
        goalId: inspected.goal.id,
        directory: inspected.directory,
        sessionId: child.id,
        messageId: childMessage.info.id,
        taskPart: binding,
        taskChildSessionId: child.id,
        parentMessageId: rootMessage.info.id,
      });
      await saveState(state);
      await attemptAbort(state);
      return;
    }

    if (!incompleteAssistant(rootMessage)) return;
    let taskPart = null;
    let taskChildSessionId = '';
    if (rootPendingTools.length > 0) {
      if (rootPendingTools.length !== 1) return;
      const childId = taskChildId(rootPendingTools[0]);
      const child = inspected.tree.get(childId);
      if (!child || child.parentID !== rootId) return;
      const childMessage = await latestMessage(childId, inspected.directory);
      if (!terminalAssistant(childMessage)) return;
      taskPart = rootPendingTools[0];
      taskChildSessionId = childId;
    }
    const activity = messageActivity(taskPart ? null : inspected.root, rootMessage);
    if (!activity || now() - activity < staleMs) return;
    const state = newState({
      rootId,
      goalId: inspected.goal.id,
      directory: inspected.directory,
      sessionId: rootId,
      messageId: rootMessage.info.id,
      taskPart,
      taskChildSessionId,
      parentMessageId: taskPart ? rootMessage.info.id : '',
    });
    await saveState(state);
    await attemptAbort(state);
  };

  const scanNow = async () => {
    if (scanning) return scanning;
    scanning = (async () => {
      if (!isEnabled()) return;
      for (const [rootId, directory] of [...roots]) {
        await checkRoot(rootId, directory).catch((error) => {
          logger.warn('[session-goal] stale recovery check failed:', { rootId, error: error?.message || error });
        });
      }
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  const start = () => {
    if (scanTimer || discoveryTimer) return;
    void discoverNow().then(scanNow);
    scanTimer = setIntervalImpl(() => void scanNow(), pollMs);
    discoveryTimer = setIntervalImpl(() => void discoverNow(), discoveryMs);
    scanTimer?.unref?.();
    discoveryTimer?.unref?.();
  };

  const stop = () => {
    if (scanTimer) clearIntervalImpl(scanTimer);
    if (discoveryTimer) clearIntervalImpl(discoveryTimer);
    scanTimer = null;
    discoveryTimer = null;
    roots.clear();
  };

  return { discoverNow, observe, scanNow, start, stop };
};
