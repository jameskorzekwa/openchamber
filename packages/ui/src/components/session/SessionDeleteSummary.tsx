import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn, formatPathForDisplay } from '@/lib/utils';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { useI18n } from '@/lib/i18n';

type SessionDeleteSummaryProps = {
    sessions: Session[];
    isWorktreeDelete: boolean;
    targetWorktree: WorktreeMetadata | null | undefined;
    homeDirectory: string | null;
    hasDirtyWorktrees: boolean;
};

export function SessionDeleteSummary({
    sessions,
    isWorktreeDelete,
    targetWorktree,
    homeDirectory,
    hasDirtyWorktrees,
}: SessionDeleteSummaryProps): React.ReactNode {
    const { t } = useI18n();
    return (
        <div className={cn(isWorktreeDelete ? 'space-y-3' : 'space-y-2')}>
            {sessions.length > 0 && (
                <div className={cn(
                    isWorktreeDelete ? 'oc-tile rounded-lg p-3' : 'oc-tile space-y-1.5 rounded-lg p-3'
                )}>
                    {isWorktreeDelete && (
                        <div className="flex items-center gap-2">
                            <span className="typography-meta font-medium text-foreground">
                                {sessions.length === 1
                                    ? t('sessions.sidebar.sessionDialogs.linkedSessionSingle')
                                    : t('sessions.sidebar.sessionDialogs.linkedSessionPlural')}
                            </span>
                            <span className="typography-micro text-muted-foreground">
                                {sessions.length}
                            </span>
                        </div>
                    )}
                    <ul className={cn(isWorktreeDelete ? 'mt-2 space-y-1' : 'space-y-0.5')}>
                        {sessions.slice(0, 5).map((session) => (
                            <li
                                key={session.id}
                                className={cn(
                                    isWorktreeDelete
                                        ? 'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground'
                                        : 'typography-micro text-muted-foreground'
                                )}
                            >
                                <span className={cn(!isWorktreeDelete && 'hidden')}>
                                    •
                                </span>
                                <span dir="auto" className="oc-ui-start-align truncate">
                                    {session.title || t('sessions.sidebar.session.untitled')}
                                </span>
                            </li>
                        ))}
                        {sessions.length > 5 && (
                            <li className={cn(
                                isWorktreeDelete
                                    ? 'px-2.5 py-1 text-xs text-muted-foreground'
                                    : 'typography-micro text-muted-foreground'
                            )}>
                                {t('sessions.sidebar.dialogs.sessionList.more', { count: sessions.length - 5 })}
                            </li>
                        )}
                    </ul>
                </div>
            )}

            {isWorktreeDelete ? (
                <div className="oc-tile space-y-2 rounded-lg p-3">
                    <div className="flex items-center gap-2">
                        <Icon name="worktree" className="h-4 w-4 text-muted-foreground" />
                        <span className="typography-meta font-medium text-foreground">{t('sessions.sidebar.sessionDialogs.worktree.label')}</span>
                        {targetWorktree?.label ? (
                            <span className="typography-micro text-muted-foreground">{targetWorktree.label}</span>
                        ) : null}
                    </div>
                    <p className="typography-micro text-muted-foreground break-all">
                        {targetWorktree
                            ? formatPathForDisplay(targetWorktree.path, homeDirectory)
                            : t('sessions.sidebar.sessionDialogs.worktree.pathUnavailable')}
                    </p>
                    {hasDirtyWorktrees && (
                        <p className="typography-micro text-status-warning">{t('sessions.sidebar.sessionDialogs.worktree.uncommittedWarning')}</p>
                    )}

                </div>
            ) : (
                <div className="oc-tile rounded-lg p-3">
                    <p className="typography-meta text-muted-foreground">
                        {t('sessions.sidebar.sessionDialogs.delete.note')}
                    </p>
                </div>
            )}
        </div>
    );
}
