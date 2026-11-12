import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { formatSessionActivityDuration } from '@/components/session/sessionActivityDurationFormat';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { areRunningSubtaskListsEqual, listRunningSubtasks, type RunningSubtask } from './runningSubtasks';
import { useOpenChildSession } from './work-status/useOpenChildSession';

type BackgroundWorkBannerProps = {
  sessionId: string | null | undefined;
  directory: string | null | undefined;
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

/** Its own leaf, so the once-a-second tick re-renders this text alone. */
const SubtaskElapsed: React.FC<{ startedAt: number }> = ({ startedAt }) => {
  const { t } = useI18n();
  const now = useDurationTickerNow(true);
  return (
    <span className="shrink-0 typography-meta tabular-nums text-muted-foreground">
      {formatSessionActivityDuration(now - startedAt, t)}
    </span>
  );
};

/**
 * Background subtasks of the session (child sessions whose live status is
 * busy), as a composer top row beside the background-commands row: the
 * agent often ends its turn while they run, and nothing else in the chat says
 * what it is waiting on. One subtask is its own row; several collapse into a
 * count that expands in place. Commands the agent left running are listed by
 * `BackgroundShellsStrip`, which opens their output.
 */
export const BackgroundWorkBanner: React.FC<BackgroundWorkBannerProps> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const subtasks = useRunningSubtasks(sessionId, directory ?? undefined);
  const openChildSession = useOpenChildSession(directory ?? null);
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();

  if (!sessionId || subtasks.length === 0) return null;

  const summary = subtasks.length === 1
    ? t('chat.backgroundWork.subtaskCountOne')
    : t('chat.backgroundWork.subtaskCountMany', { count: subtasks.length });

  const rows = subtasks.map((subtask) => {
    const label = subtask.title ?? t('chat.backgroundWork.subtaskUntitled');
    const openLabel = t('chat.workStatus.action.openSubagent', { name: label });
    return (
      <button
        key={subtask.id}
        type="button"
        onClick={directory ? () => openChildSession(subtask.id, label) : undefined}
        disabled={!directory}
        onMouseDown={(event) => event.preventDefault()}
        aria-label={openLabel}
        title={openLabel}
        className="flex oc-composer-row w-full min-w-0 items-center gap-2 ps-3 pe-3 text-start transition-colors hover:bg-interactive-hover"
      >
        <Icon name="ai-agent" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate typography-meta text-foreground">{label}</span>
        <SubtaskElapsed startedAt={subtask.startedAt} />
      </button>
    );
  });

  if (subtasks.length === 1) {
    return (
      <div role="group" className="border-b border-edge" aria-label={t('chat.backgroundWork.ariaLabel', { summary })}>
        {rows}
      </div>
    );
  }

  return (
    <div role="group" className="border-b border-edge" aria-label={t('chat.backgroundWork.ariaLabel', { summary })}>
      <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          onMouseDown={(event) => event.preventDefault()}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
        >
          <Icon name="ai-agent" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start">{t('chat.backgroundWork.label')} · {summary}</span>
          <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </div>
      {expanded ? <div id={listId}>{rows}</div> : null}
    </div>
  );
};
