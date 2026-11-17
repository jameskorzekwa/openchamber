import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * J2K: the composer's background-work rows (commands, images, subtasks) are
 * tinted with the theme accent and carry an accent bar on their leading edge,
 * so a session the agent left waiting on background work stands out from the
 * plain composer rows around it.
 */
export const BACKGROUND_ROW_GROUP_CLASS = 'border-b border-edge border-s-2 border-s-primary bg-primary/10';

/**
 * The row's leading icon in the accent color, with a slowly pulsing dot that
 * says the work is live. The pulse stops under reduced motion.
 */
export const BackgroundRowIcon: React.FC<{ name: IconName; className?: string }> = ({ name, className }) => (
  <span className={cn('relative inline-flex shrink-0', className)} aria-hidden="true">
    <Icon name={name} className="size-3.5 text-primary" />
    <span className="absolute -end-0.5 -top-0.5 flex size-1.5">
      <span className="absolute inline-flex size-full rounded-full bg-primary opacity-75 motion-safe:animate-ping" />
      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
    </span>
  </span>
);

/** The "Agent waiting" tag, shown once per group (its only row, or its header). */
export const AgentWaitingLabel: React.FC = () => {
  const { t } = useI18n();
  return (
    <span className="shrink-0 typography-meta font-medium text-primary">
      {t('chat.backgroundWork.agentWaiting')}
    </span>
  );
};
