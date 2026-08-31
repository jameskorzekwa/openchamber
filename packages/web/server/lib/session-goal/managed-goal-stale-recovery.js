const DEFAULT_STALE_MS = 15 * 60 * 1_000;
const DEFAULT_POLL_MS = 60 * 1_000;
const DEFAULT_DISCOVERY_MS = 5 * 60 * 1_000;
const SESSION_TREE_LIMIT = 1_000;
const HELD_STATUS_REASONS = new Set(['worktree-moving', 'worktree-resume-dispatching']);

const goalFrom = (session) => session?.metadata?.openchamber?.goal;

const isActiveManagedGoal = (session) => {
  const goal = goalFrom(session);
  return goal?.managedWorktree === true
    && goal?.status === 'active'
    && !HELD_STATUS_REASONS.has(goal?.statusReason)
    && typeof goal.id === 'string'
    && goal.id;
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

const pendingTools = (message) => (message?.parts ?? []).filter((part) => (
  part?.type === 'tool' && !['completed', 'error'].includes(part?.state?.status)
));

const taskChildId = (part) => {
  if (part?.tool !== 'task' || part?.state?.status !== 'running') return '';
  const metadata = part.state?.metadata;
  return typeof metadata?.sessionId === 'string' ? metadata.sessionId : '';
};

const sessionList = (payload) => {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.data) ? payload.data : [];
};

export const createManagedGoalStaleRecovery = ({
  openCodeFetch,
  staleMs = DEFAULT_STALE_MS,
  pollMs = DEFAULT_POLL_MS,
  discoveryMs = DEFAULT_DISCOVERY_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  isEnabled = () => true,
  logger = console,
} = {}) => {
  if (typeof openCodeFetch !== 'function') throw new TypeError('openCodeFetch is required');

  const roots = new Map();
  const pendingResumes = new Map();
  let scanTimer = null;
  let discoveryTimer = null;
  let scanning = null;
  let discovering = null;

  const observe = (update) => {
    if (!update || update.parentID || typeof update.sessionId !== 'string' || !update.sessionId) return;
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
      const payload = await openCodeFetch('/experimental/session', {
        query: { archived: 'true', limit: '10000' },
      });
      for (const session of sessionList(payload)) {
        if (session?.parentID || typeof session?.id !== 'string') continue;
        if (isActiveManagedGoal(session)) roots.set(session.id, session.directory || '');
        else roots.delete(session.id);
      }
    })().catch((error) => {
      logger.warn('[session-goal] stale recovery discovery failed:', error?.message || error);
    }).finally(() => {
      discovering = null;
    });
    return discovering;
  };

  const latestMessage = async (sessionId, directory) => {
    const messages = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: '1' },
    });
    return Array.isArray(messages) ? messages.at(-1) ?? null : null;
  };

  const fetchTree = async (root, directory) => {
    const tree = new Map([[root.id, root]]);
    const pending = [root.id];
    while (pending.length > 0) {
      const sessionId = pending.shift();
      const children = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/children`, { directory });
      if (!Array.isArray(children)) throw new Error(`invalid child session response for ${sessionId}`);
      for (const child of children) {
        if (typeof child?.id !== 'string' || tree.has(child.id)) continue;
        if (tree.size >= SESSION_TREE_LIMIT) throw new Error('managed goal session tree exceeded safety limit');
        tree.set(child.id, child);
        pending.push(child.id);
      }
    }
    return tree;
  };

  const resumeRoot = async (rootId, directory, expectedGoalId) => {
    let session = null;
    // The abort response and OpenCode's message event are concurrent. Wait for
    // the event-side pause when possible, then make the resume write last.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sleep(100);
      session = await openCodeFetch(`/session/${encodeURIComponent(rootId)}`, { directory });
      if (goalFrom(session)?.status === 'paused') break;
    }
    const goal = goalFrom(session);
    if (goal?.id !== expectedGoalId || goal?.managedWorktree !== true || goal?.status === 'complete') return false;
    if (goal.status === 'paused' && goal.statusReason !== 'paused after abort') return false;
    if (!['active', 'paused'].includes(goal.status)) return false;
    const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    const namespace = metadata.openchamber && typeof metadata.openchamber === 'object' ? metadata.openchamber : {};
    const nextGoal = { ...goal, status: 'active', statusReason: 'resumed', updatedAt: now() };
    await openCodeFetch(`/session/${encodeURIComponent(rootId)}`, {
      directory,
      method: 'PATCH',
      body: { metadata: { ...metadata, openchamber: { ...namespace, goal: nextGoal } } },
    });
    return true;
  };

  const recover = async ({ sessionId, rootId, directory, goalId, reason }) => {
    if (sessionId === rootId) pendingResumes.set(rootId, { directory, goalId });
    try {
      await openCodeFetch(`/session/${encodeURIComponent(sessionId)}/abort`, { directory, method: 'POST' });
    } catch (error) {
      if (sessionId === rootId) pendingResumes.delete(rootId);
      throw error;
    }
    if (sessionId === rootId) {
      const resumed = await resumeRoot(rootId, directory, goalId);
      if (resumed !== undefined) pendingResumes.delete(rootId);
    }
    logger.warn(`[session-goal] recovered stale managed-goal ${reason}`, { rootId, sessionId });
  };

  const taskPointsToTerminalChild = async ({ part, tree, statuses, directory }) => {
    const childId = taskChildId(part);
    if (!childId || !tree.has(childId) || ['busy', 'retry'].includes(statuses?.[childId]?.type)) return false;
    const childMessage = await latestMessage(childId, directory);
    return Boolean(childMessage?.info?.error || childMessage?.info?.time?.completed > 0);
  };

  const checkRoot = async (rootId, directoryHint) => {
    const root = await openCodeFetch(`/session/${encodeURIComponent(rootId)}`, { directory: directoryHint });
    if (!isActiveManagedGoal(root) || root.parentID) {
      roots.delete(rootId);
      return;
    }
    const directory = root.directory || directoryHint;
    if (!directory) return;
    roots.set(rootId, directory);

    const statuses = await openCodeFetch('/session/status', { directory });
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return;
    const tree = await fetchTree(root, directory);
    const goalId = goalFrom(root).id;

    // Children first: a foreground task can settle normally when only its child
    // stream is stale, avoiding an unnecessary parent abort.
    const candidates = [...tree.values()].sort((left, right) => (
      left.id === rootId ? 1 : right.id === rootId ? -1 : 0
    ));
    let recoveredChild = false;
    for (const candidate of candidates) {
      const sessionId = candidate.id;
      if (sessionId === rootId && recoveredChild) return;
      const status = statuses[sessionId]?.type;
      if (status === 'retry') continue;
      const [session, message] = await Promise.all([
        sessionId === rootId
          ? root
          : openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory }),
        latestMessage(sessionId, directory),
      ]);
      if (!incompleteAssistant(message)) continue;
      const pending = pendingTools(message);
      let orphanedTask = false;
      if (pending.length > 0) {
        orphanedTask = sessionId === rootId
          && pending.length === 1
          && await taskPointsToTerminalChild({ part: pending[0], tree, statuses, directory });
        if (!orphanedTask) continue;
      }

      // Session metadata can move when a child aborts even though its parent
      // task tool remains orphaned. For that verified terminal-child case,
      // measure the task message itself instead of the parent session record.
      const activity = messageActivity(orphanedTask ? null : session, message);
      if (!activity || now() - activity < staleMs) continue;

      if (orphanedTask) {
        await recover({ sessionId, rootId, directory, goalId, reason: 'orphaned task' });
        return;
      }

      await recover({ sessionId, rootId, directory, goalId, reason: 'model stream' });
      if (sessionId === rootId) return;
      recoveredChild = true;
    }
  };

  const scanNow = async () => {
    if (scanning) return scanning;
    scanning = (async () => {
      if (!isEnabled()) return;
      for (const [rootId, pending] of [...pendingResumes]) {
        try {
          const resumed = await resumeRoot(rootId, pending.directory, pending.goalId);
          if (resumed !== undefined) pendingResumes.delete(rootId);
        } catch (error) {
          logger.warn('[session-goal] stale recovery resume failed:', { rootId, error: error?.message || error });
        }
      }
      for (const [rootId, directory] of [...roots]) {
        if (pendingResumes.has(rootId)) continue;
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
    if (typeof scanTimer?.unref === 'function') scanTimer.unref();
    if (typeof discoveryTimer?.unref === 'function') discoveryTimer.unref();
  };

  const stop = () => {
    if (scanTimer) clearIntervalImpl(scanTimer);
    if (discoveryTimer) clearIntervalImpl(discoveryTimer);
    scanTimer = null;
    discoveryTimer = null;
    roots.clear();
    pendingResumes.clear();
  };

  return { discoverNow, observe, scanNow, start, stop };
};
