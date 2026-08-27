import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { useI18n } from '@/lib/i18n';
import { formatPtyWaitingElapsed, getPtyWaitingState } from '@/lib/ptyWaitingState';

type PtyWaitingBannerProps = {
  session: Session | null | undefined;
};

export const PtyWaitingBanner: React.FC<PtyWaitingBannerProps> = ({ session }) => {
  const { t } = useI18n();
  const waiting = getPtyWaitingState(session);
  const [now, setNow] = React.useState(Date.now);

  React.useEffect(() => {
    if (waiting.oldestCreatedAt === null) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting.oldestCreatedAt]);

  if (waiting.count === 0 || waiting.oldestCreatedAt === null) return null;

  const description = waiting.count === 1
    ? waiting.description ?? t('chat.ptyWaiting.backgroundProcess')
    : t('chat.ptyWaiting.backgroundProcesses', { count: waiting.count });
  const waitingLabel = waiting.count === 1
    ? waiting.description
      ? t('chat.ptyWaiting.ariaSingleDescription', { description: waiting.description })
      : t('chat.ptyWaiting.ariaSingleDefault')
    : t('chat.ptyWaiting.ariaMany', { count: waiting.count });
  const elapsed = formatPtyWaitingElapsed((now - waiting.oldestCreatedAt) / 1000);

  return (
    <div className="chat-message-column mb-3">
      <div
        className="flex items-center justify-between gap-3 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-3 py-2"
        title={waitingLabel}
        aria-label={waitingLabel}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" aria-hidden="true" />
          <span className="flex-shrink-0 typography-ui-label text-[var(--status-warning)]">
            {t('chat.ptyWaiting.label')}
          </span>
          <span className="truncate typography-meta text-muted-foreground">{description}</span>
        </span>
        <span className="flex-shrink-0 font-mono typography-meta tabular-nums text-[var(--status-warning)]">
          {elapsed}
        </span>
      </div>
    </div>
  );
};
