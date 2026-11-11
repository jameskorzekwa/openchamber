import type { Session, SessionStatus } from '@/lib/opencode/model';

export type RunningSubtask = {
  id: string;
  title: string | null;
  startedAt: number;
};

/**
 * Child sessions of `parentId` whose live status says they are still working.
 *
 * Live status is the only authority here: a Task tool row in the transcript
 * finalizes the moment a background subtask is launched, so it cannot tell
 * whether the child is still running. The child's own `session_status` can.
 * Oldest first, so the list reads in launch order.
 */
export function listRunningSubtasks(
  sessions: readonly Session[],
  statuses: Readonly<Record<string, SessionStatus>>,
  parentId: string | null | undefined,
): RunningSubtask[] {
  if (!parentId) return [];
  const running: RunningSubtask[] = [];
  for (const session of sessions) {
    if (session.parentID !== parentId) continue;
    const status = statuses[session.id]?.type;
    if (status !== 'busy' && status !== 'retry') continue;
    running.push({
      id: session.id,
      title: session.title.trim() || null,
      startedAt: session.time.created,
    });
  }
  running.sort((left, right) => left.startedAt - right.startedAt);
  return running;
}

export function areRunningSubtaskListsEqual(previous: readonly RunningSubtask[], next: readonly RunningSubtask[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((subtask, index) => {
    const other = next[index];
    return subtask.id === other.id && subtask.title === other.title && subtask.startedAt === other.startedAt;
  });
}
