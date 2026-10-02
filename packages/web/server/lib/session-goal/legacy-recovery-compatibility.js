import { readManagedGoalRecoveryState } from './managed-goal-recovery-state.js';

export const isLegacyRecoveryHold = (goal) => goal?.statusReason?.startsWith('stale-recovery:') === true;

// A missing journal permits ordinary goal work. A journal in either phase,
// malformed data, or a failed read requires inspection, never automatic replay.
export const hasUnresolvedManagedRecovery = async (sessionId, options = {}) => {
  try {
    return await readManagedGoalRecoveryState(sessionId, options) !== null;
  } catch {
    return true;
  }
};

export const hasNonterminalChildTool = (content) => Array.isArray(content) && content.some((item) => (
  item?.type === 'tool'
  && (item.name === 'subagent' || item.name === 'task')
  && !['completed', 'error'].includes(item.state?.status)
));
