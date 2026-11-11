import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatPtyWaitingElapsed, getPtyWaitingState } from '@/lib/ptyWaitingState';
import { useDirectorySync, useSession } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { areRunningSubtaskListsEqual, listRunningSubtasks, type RunningSubtask } from './runningSubtasks';
import { useOpenPtyInspector } from './useOpenPtyInspector';
import { useOpenSubagentSession } from './useOpenSubagentSession';

type BackgroundWorkBannerProps = {
  sessionId: string | null | undefined;
  directory: string | null | undefined;
  /** Another composer panel (queue, BTW) owns the dock right now. */
  hidden?: boolean;
};

const selectSessions = (state: State) => state.session;
const selectStatuses = (state: State) => state.session_status;

/**
 * Live subtasks of the session. The directory store is the authority for both
 * the child sessions and their status; the list identity only changes when a
 * row would render differently, so status churn elsewhere does not repaint it.
 */
function useRunningSubtasks(sessionId: string | null | undefined, directory: string | undefined): RunningSubtask[] {
  const sessions = useDirectorySync(selectSessions, directory);
  const statuses = useDirectorySync(selectStatuses, directory);
  const previousRef = React.useRef<RunningSubtask[]>([]);
  return React.useMemo(() => {
    const next = listRunningSubtasks(sessions, statuses, sessionId);
    if (areRunningSubtaskListsEqual(previousRef.current, next)) return previousRef.current;
    previousRef.current = next;
    return next;
  }, [sessionId, sessions, statuses]);
}

const ROW_CLASS = 'flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left';

const BackgroundWorkRow: React.FC<{
  icon: 'ai-agent' | 'terminal';
  label: string;
  elapsed: string;
  onOpen?: () => void;
  openLabel?: string;
}> = ({ icon, label, elapsed, onOpen, openLabel }) => {
  const body = (
    <>
      <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate typography-meta text-foreground">{label}</span>
      <span className="shrink-0 font-mono typography-meta tabular-nums text-muted-foreground">{elapsed}</span>
    </>
  );
  if (!onOpen) return <div className={ROW_CLASS}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      title={openLabel}
      className={cn(ROW_CLASS, 'transition-colors hover:bg-interactive-hover')}
    >
      {body}
    </button>
  );
};

/**
 * What this session is still waiting on: background subtasks (child sessions
 * whose live status is busy) and hosted PTY processes the agent asked to be
 * notified about. Docked above the composer like the queue panel, so it keeps
 * its place while the transcript streams instead of riding the list footer.
 */
export const BackgroundWorkBanner: React.FC<BackgroundWorkBannerProps> = ({ sessionId, directory, hidden = false }) => {
  const { t } = useI18n();
  const session = useSession(sessionId ?? undefined, directory ?? undefined);
  const subtasks = useRunningSubtasks(sessionId, directory ?? undefined);
  const waiting = getPtyWaitingState(session);
  const openSubagentSession = useOpenSubagentSession(directory ?? null);
  const openPtyInspector = useOpenPtyInspector(directory ?? null);
  const active = !hidden && (subtasks.length > 0 || waiting.count > 0);
  const [now, setNow] = React.useState(Date.now);

  React.useEffect(() => {
    if (!active) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const subtaskCount = subtasks.length === 1
    ? t('chat.backgroundWork.subtaskCountOne')
    : t('chat.backgroundWork.subtaskCountMany', { count: subtasks.length });
  const processCount = waiting.count === 1
    ? t('chat.backgroundWork.processCountOne')
    : t('chat.backgroundWork.processCountMany', { count: waiting.count });
  const summary = [
    subtasks.length > 0 ? subtaskCount : null,
    waiting.count > 0 ? processCount : null,
  ].filter((part): part is string => part !== null).join(' · ');

  return (
    <ComposerFloatingPanel
      role="region"
      ariaLabel={t('chat.backgroundWork.ariaLabel', { summary })}
      compact
      header={(
        <>
          <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" aria-hidden="true" />
          <span className="flex-shrink-0 typography-ui-label text-[var(--status-warning)]">
            {t('chat.backgroundWork.label')}
          </span>
          <span className="min-w-0 truncate typography-meta text-muted-foreground">{summary}</span>
        </>
      )}
    >
      <div className="flex flex-col px-2 pb-1.5" data-background-work-rows>
        {subtasks.map((subtask) => {
          const label = subtask.title ?? t('chat.backgroundWork.subtaskUntitled');
          return (
            <BackgroundWorkRow
              key={subtask.id}
              icon="ai-agent"
              label={label}
              elapsed={formatPtyWaitingElapsed((now - subtask.startedAt) / 1000)}
              onOpen={directory ? () => openSubagentSession(subtask.id, label) : undefined}
              openLabel={t('chat.workStatus.action.openSubagent', { name: label })}
            />
          );
        })}
        {waiting.jobs.map((job) => {
          const label = job.description ?? t('chat.ptyWaiting.backgroundProcess');
          return (
            <BackgroundWorkRow
              key={job.id}
              icon="terminal"
              label={label}
              elapsed={formatPtyWaitingElapsed((now - job.createdAt) / 1000)}
              onOpen={openPtyInspector ? () => openPtyInspector(job.id, label) : undefined}
              openLabel={t('chat.backgroundWork.openProcess', { name: label })}
            />
          );
        })}
      </div>
    </ComposerFloatingPanel>
  );
};
