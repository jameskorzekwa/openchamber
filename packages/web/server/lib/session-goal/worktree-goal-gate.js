import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STATE_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const defaultStateDirectory = () => path.join(os.homedir(), '.local', 'state', 'opencode', 'session-worktrees');

const hasDeploymentEvidence = (deployment) => (
  deployment
  && typeof deployment === 'object'
  && typeof deployment.target === 'string'
  && deployment.target.trim().length > 0
  && typeof deployment.commit === 'string'
  && /^[a-f0-9]{40}$/.test(deployment.commit)
  && Number.isInteger(deployment.status)
  && deployment.status >= 200
  && deployment.status < 300
  && typeof deployment.bodySha256 === 'string'
  && /^[a-f0-9]{64}$/.test(deployment.bodySha256)
  && Number.isFinite(deployment.verifiedAt)
);

const readState = async (sessionID, stateDirectory) => {
  if (!SESSION_ID_PATTERN.test(sessionID)) return null;
  try {
    const state = JSON.parse(await readFile(path.join(stateDirectory, `${sessionID}.json`), 'utf8'));
    return state?.version === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
};

export const writeManagedWorktreeGoalProgress = async (sessionID, goal, options = {}) => {
  if (!SESSION_ID_PATTERN.test(sessionID) || goal?.managedWorktree !== true || typeof goal?.id !== 'string') return;
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const state = await readState(sessionID, stateDirectory);
  if (!state || state.managedGoalID !== goal.id) return;
  await import('node:fs/promises').then(async ({ mkdir, rename, writeFile }) => {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(stateDirectory, `${sessionID}.goal.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(goal)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  });
};

export const readManagedWorktreeGoalRecord = async (sessionID, options = {}) => {
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const state = await readState(sessionID, stateDirectory);
  let goal = null;
  try {
    goal = JSON.parse(await readFile(path.join(stateDirectory, `${sessionID}.goal.json`), 'utf8'));
  } catch {}
  if (!goal || goal.id !== state?.managedGoalID) goal = state?.managedGoal;
  if (!state?.managedGoalID || !goal || goal.id !== state.managedGoalID || goal.managedWorktree !== true) return null;
  return {
    goal,
    protected: state.phase !== 'moving-to-worktree' && state.phase !== 'goal-completion-pending' && state.phase !== 'complete',
  };
};

export const readManagedWorktreeGoalObjective = async (sessionID, goalID, options = {}) => {
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const state = await readState(sessionID, stateDirectory);
  if (state?.managedGoalID !== goalID || typeof state.managedGoalObjective !== 'string') return null;
  return state.managedGoalObjective.trim() || null;
};

export const readManagedWorktreeGoalGate = async (sessionID, goalID, options = {}) => {
  if (!SESSION_ID_PATTERN.test(sessionID)) {
    return { complete: false, note: 'Managed worktree session id is invalid; recover the lifecycle before completing the goal.' };
  }
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const state = await readState(sessionID, stateDirectory);
  if (!state) {
    return { complete: false, note: 'Managed worktree state is unavailable; recover the lifecycle before completing the goal.' };
  }

  if (state?.version !== STATE_VERSION || state?.managedGoalID !== goalID) {
    return { complete: false, note: 'Managed worktree goal state does not match this session; recover it before completing the goal.' };
  }

  const lifecycleComplete = state.phase === 'goal-completion-pending' || state.phase === 'complete';
  if (lifecycleComplete && hasDeploymentEvidence(state.devDeployment)) {
    return { complete: true, note: 'Implementation, dev deployment, merge, cleanup, and return to the primary workspace are complete.' };
  }

  if (!hasDeploymentEvidence(state.devDeployment)) {
    return { complete: false, note: 'Finish implementation and provide verified dev deployment evidence before returning to the primary workspace.' };
  }
  if (state.phase === 'attached' || state.phase === 'moving-to-worktree') {
    return { complete: false, note: 'Finish the managed worktree, merge it, and return the session to the primary workspace.' };
  }
  return { complete: false, note: 'Managed worktree cleanup and return to the primary workspace are still incomplete.' };
};
