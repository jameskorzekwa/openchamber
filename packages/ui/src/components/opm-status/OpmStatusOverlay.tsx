import React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

import {
  fetchOpmStatus,
  getOpmCounts,
  openOpmRowSession,
  ownerGuidanceKind,
  type OpmAvailableSnapshot,
  type OpmRow,
  type OpmSnapshot,
  type OpmStatusLoadResult,
  type OpmTreeRow,
} from './opm-status';

const POLL_INTERVAL_MS = 15_000;
const NOTIFIED_KEY = 'opmStatus.notified';
const notifiedKeysSchema = z.array(z.string());

type Translate = ReturnType<typeof useI18n>['t'];

const phaseLabel = (phase: string | null, t: Translate) => {
  switch (phase) {
    case 'planned': return t('opm.phase.planned');
    case 'active': return t('opm.phase.active');
    case 'waiting_owner': return t('opm.phase.waitingOwner');
    case 'waiting_external': return t('opm.phase.waiting');
    case 'paused': return t('opm.phase.paused');
    case 'blocked': return t('opm.phase.blocked');
    case 'review': return t('opm.phase.review');
    case 'merged': return t('opm.phase.merged');
    case 'deployed': return t('opm.phase.deployed');
    case 'verified': return t('opm.phase.verified');
    case 'completed': return t('opm.phase.completed');
    case 'cancelled': return t('opm.phase.cancelled');
    case 'failed': return t('opm.phase.failed');
    case 'idle': return t('opm.phase.idle');
    default: return phase?.replaceAll('_', ' ') || t('common.unavailable');
  }
};

const relativeAge = (value: string | number | null, locale: string) => {
  const at = new Date(value ?? '').getTime();
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (seconds < 90) return formatter.format(-seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return formatter.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 36) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.round(hours / 24), 'day');
};

const rowTone = (row: OpmRow) => {
  if (row.kind) return 'border-status-error/40 bg-status-error/10';
  if (row.phase === 'blocked' || row.phase === 'failed' || row.phase === 'paused') {
    return 'border-status-warning/30 bg-status-warning/5';
  }
  return 'border-border/60 bg-[var(--surface-elevated)]';
};

const phaseTone = (row: OpmRow) => {
  if (row.kind || row.phase === 'blocked' || row.phase === 'failed') return 'text-status-error bg-status-error/10';
  if (row.phase === 'paused' || row.phase === 'planned' || row.activityState === 'queued') return 'text-status-warning bg-status-warning/10';
  if (row.phase === 'active' || row.phase === 'review') return 'text-status-success bg-status-success/10';
  return 'text-status-info bg-status-info/10';
};

const ownerText = (row: OpmRow, t: Translate) => {
  switch (ownerGuidanceKind(row)) {
    case 'authorize': return t('opm.owner.authorize', { ref: row.ref });
    case 'deadLetter': return t('opm.owner.deadLetter', { ref: row.ref });
    case 'paused': return t('opm.owner.paused', { ref: row.ref });
    case 'children': return t('opm.owner.children');
    case 'review': return t('opm.owner.review');
    case 'checks': return t('opm.owner.checks');
    case 'deployment': return t('opm.owner.deployment');
    case 'worker': return t('opm.owner.worker');
    case 'working': return t('opm.owner.working');
    case 'nextAction': return t('opm.owner.nextAction', { action: row.nextAction ?? '' });
    case 'none': return t('opm.owner.none');
  }
};

const notifyNeedsOwner = (snapshot: OpmSnapshot, t: Translate) => {
  if (!snapshot.available || !globalThis.Notification || Notification.permission !== 'granted') return;
  let seen: string[] = [];
  try {
    const parsed = notifiedKeysSchema.safeParse(JSON.parse(sessionStorage.getItem(NOTIFIED_KEY) ?? '[]'));
    if (parsed.success) seen = parsed.data;
  } catch {
    seen = [];
  }
  const notified = new Set(seen);
  for (const row of snapshot.groups.needsYou) {
    const key = `${row.project}#${row.ref}:${row.command || row.reason || ''}`;
    if (notified.has(key)) continue;
    notified.add(key);
    try {
      new Notification(t('opm.notification.title'), {
        body: t('opm.notification.body', { item: `${row.projectName || row.project} #${row.ref}: ${row.command || row.reason || row.title}` }),
        tag: key,
      });
    } catch {
      // Some embedded browsers expose Notification but reject construction.
    }
  }
  try {
    sessionStorage.setItem(NOTIFIED_KEY, JSON.stringify([...notified].slice(-50)));
  } catch {
    // Session storage is optional.
  }
};

const OpmWorkRow = ({
  row,
  nested = false,
  onCopy,
  copiedCommand,
  onOpenSession,
}: {
  row: OpmRow;
  nested?: boolean;
  onCopy: (command: string) => void;
  copiedCommand: string | null;
  onOpenSession: (row: OpmRow) => void;
}) => {
  const { locale, t } = useI18n();
  const projectLabel = `${row.projectName || row.project || 'OPM'} #${row.ref}`;
  return (
    <article className={cn('rounded-lg border p-3', rowTone(row), nested && 'ml-4')}>
      <div className="flex flex-wrap items-center gap-2">
        {row.url ? (
          <a className="inline-flex items-center gap-1 font-medium text-foreground hover:underline" href={row.url} target="_blank" rel="noreferrer">
            {projectLabel}<Icon name="external-link" className="size-3" />
          </a>
        ) : <span className="font-medium text-foreground">{projectLabel}</span>}
        <span className={cn('rounded-full px-2 py-0.5 typography-micro', phaseTone(row))}>{phaseLabel(row.phase, t)}</span>
        {row.parentRef ? <span className="typography-micro text-muted-foreground">{t('opm.row.childOf', { ref: row.parentRef })}</span> : null}
        <span className="ml-auto typography-micro text-muted-foreground">{relativeAge(row.updatedAt, locale)}</span>
      </div>
      <p className="mt-1 typography-ui-label text-foreground">{row.title}</p>
      {row.reason ? <p className="mt-1 typography-ui-label text-muted-foreground">{row.reason}</p> : null}
      {row.nextAction && row.nextAction !== row.reason ? <p className="mt-1 typography-ui-label text-muted-foreground">{t('opm.row.nextAction', { action: row.nextAction })}</p> : null}
      <div className={cn(
        'mt-2 rounded-md px-2.5 py-2 typography-ui-label',
        row.owner.required ? 'bg-status-error/10 text-status-error' : 'bg-status-success/10 text-status-success',
      )}>
        {ownerText(row, t)}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.command ? (
          <>
            <code className="min-w-0 flex-1 [overflow-wrap:anywhere] rounded-md bg-background px-2 py-1.5 typography-micro text-foreground">{row.command}</code>
            <Button size="xs" variant="outline" onClick={() => onCopy(row.command ?? '')}>
              <Icon name={copiedCommand === row.command ? 'check' : 'clipboard'} className="size-3" />
              {copiedCommand === row.command ? t('opm.actions.copied') : t('opm.actions.copy')}
            </Button>
          </>
        ) : null}
        {row.sessionId ? (
          <Button size="xs" variant="outline" onClick={() => onOpenSession(row)}>
            {t('opm.actions.openSession')}
          </Button>
        ) : null}
      </div>
      {(row.branch || row.sessionId || row.effect) ? (
        <p className="mt-2 break-all font-mono typography-micro text-muted-foreground">
          {[row.branch && t('opm.row.branch', { branch: row.branch }), row.sessionId && t('opm.row.session', { session: row.sessionId }), row.effect?.kind && t('opm.row.effect', { kind: row.effect.kind, status: row.effect.status ?? '' })].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {row.effect?.error ? <p className="mt-1 typography-micro text-status-error">{row.effect.error}</p> : null}
    </article>
  );
};

const StatusDot = ({ snapshot }: { snapshot: OpmSnapshot }) => {
  const counts = snapshot.available
    ? getOpmCounts(snapshot)
    : { needsYou: 0, blocked: 0, active: 0, waiting: 0, queued: 0 };
  const tone = !snapshot.available
    ? 'bg-muted-foreground'
    : counts.needsYou > 0
      ? 'bg-status-error animate-pulse'
      : !snapshot.healthOk || snapshot.paused || counts.blocked > 0
        ? 'bg-status-warning'
        : 'bg-status-success';
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', tone)} />;
};

const SupervisorSummary = ({ snapshot }: { snapshot: OpmAvailableSnapshot }) => {
  const { locale, t } = useI18n();
  const supervisor = snapshot.supervisor;
  return (
    <section aria-label={t('opm.supervisor.title')} className="rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 typography-ui-label text-muted-foreground">
        <span className="font-medium text-foreground">{supervisor.running ? t('opm.supervisor.running') : t('opm.supervisor.stopped')}</span>
        {snapshot.paused ? <span className="text-status-warning">{t('opm.supervisor.paused')}</span> : null}
        {supervisor.lastPollAt ? <span>{t('opm.supervisor.lastPoll', { age: relativeAge(supervisor.lastPollAt, locale) })}</span> : null}
        {supervisor.counters.deadLetters !== undefined ? <span>{t('opm.supervisor.deadLetters', { count: supervisor.counters.deadLetters })}</span> : null}
        {supervisor.counters.blocked !== undefined ? <span>{t('opm.supervisor.blocked', { count: supervisor.counters.blocked })}</span> : null}
      </div>
      {supervisor.projects.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {supervisor.projects.map((project) => (
            <span key={project.projectId ?? 'unknown'} className={cn('rounded-full px-2 py-1 typography-micro', project.degraded || project.rateLimited ? 'bg-status-warning/10 text-status-warning' : 'bg-status-success/10 text-status-success')}>
              {project.projectId}: {project.degraded ? t('opm.supervisor.degraded') : project.rateLimited ? t('opm.supervisor.rateLimited') : t('opm.supervisor.healthy')}
              {project.degradedReason ? ` · ${project.degradedReason}` : ''}
            </span>
          ))}
        </div>
      ) : null}
      {supervisor.attention.length > 0 ? (
        <div className="mt-2 space-y-1 text-status-error typography-ui-label">
          {supervisor.attention.map((item, index) => (
            <p key={`${item.kind}:${item.ref}:${index}`}>{[item.kind, item.ref && `#${item.ref}`, item.detail, item.error].filter(Boolean).join(' · ')}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
};

export const OpmStatusOverlay = ({
  loadStatus = fetchOpmStatus,
  openSession = (sessionId, workspacePath) => useSessionUIStore.getState().setCurrentSession(sessionId, workspacePath),
}: {
  loadStatus?: () => Promise<OpmStatusLoadResult>;
  openSession?: (sessionId: string, workspacePath: string | null) => void;
}) => {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<OpmSnapshot | null>(null);
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [open, setOpen] = React.useState(false);
  const [copiedCommand, setCopiedCommand] = React.useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission | 'unsupported'>(
    globalThis.Notification ? Notification.permission : 'unsupported',
  );

  React.useEffect(() => {
    const refresh = async () => {
      const result = await loadStatus();
      if (result.status === 'unsupported') {
        setSupported(false);
        setOpen(false);
        return;
      }
      setSupported(true);
      setSnapshot(result.snapshot);
      notifyNeedsOwner(result.snapshot, t);
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadStatus, t]);

  if (supported !== true || !snapshot) return null;

  const counts = snapshot.available
    ? getOpmCounts(snapshot)
    : { needsYou: 0, blocked: 0, active: 0, waiting: 0, queued: 0 };
  const pillText = !snapshot.available
    ? t('opm.pill.offline')
    : counts.needsYou > 0
      ? t('opm.pill.needsYou', { count: counts.needsYou })
      : counts.blocked > 0
        ? t('opm.pill.blocked', { count: counts.blocked })
        : counts.active > 0
          ? t('opm.pill.working', { count: counts.active })
          : counts.waiting > 0
            ? t('opm.pill.waiting', { count: counts.waiting })
            : counts.queued > 0
              ? t('opm.pill.queued', { count: counts.queued })
              : t('opm.pill.idle');

  const copyCommand = (command: string) => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(null), 1_500);
    });
  };
  const openRowSession = (row: OpmRow) => {
    if (openOpmRowSession(row, openSession)) setOpen(false);
  };
  const requestNotifications = async () => {
    if (!globalThis.Notification) return;
    try {
      setNotificationPermission(await Notification.requestPermission());
    } catch {
      setNotificationPermission('denied');
    }
  };

  return (
    <>
      <Button
        aria-label={t('opm.pill.aria')}
        variant="outline"
        size="sm"
        className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-3 z-40 rounded-full bg-[var(--surface-elevated)] shadow-none"
        onClick={() => setOpen(true)}
      >
        <StatusDot snapshot={snapshot} />
        <span>{pillText}</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl gap-3 p-4 sm:p-5">
          <DialogHeader className="pr-8">
            <DialogTitle className="flex items-center gap-2"><StatusDot snapshot={snapshot} />OPM</DialogTitle>
            <DialogDescription>
              {snapshot.available
                ? `${phaseLabel(snapshot.state, t)} · ${snapshot.summary || t('opm.dialog.noSummary')} · ${t('opm.dialog.updated', { age: relativeAge(snapshot.fetchedAt, locale) })}`
                : t('opm.dialog.unavailable')}
            </DialogDescription>
          </DialogHeader>
          {!snapshot.available ? (
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-status-warning typography-ui-label">
              {t('opm.dialog.controlUnreachable')}
            </div>
          ) : (
            <div className="space-y-3">
              <SupervisorSummary snapshot={snapshot} />
              {snapshot.groups.needsYou.length > 0 ? (
                <section aria-labelledby="opm-needs-you">
                  <h3 id="opm-needs-you" className="mb-2 font-medium text-status-error">{t('opm.section.needsYou', { count: snapshot.groups.needsYou.length })}</h3>
                  <div className="space-y-2">
                    {snapshot.groups.needsYou.map((row) => <OpmWorkRow key={`${row.project}#${row.ref}`} row={row} onCopy={copyCommand} copiedCommand={copiedCommand} onOpenSession={openRowSession} />)}
                  </div>
                </section>
              ) : null}
              <section aria-labelledby="opm-work-items">
                <h3 id="opm-work-items" className="mb-2 font-medium text-foreground">{t('opm.section.workItems')}</h3>
                {snapshot.tree.length === 0 ? <p className="text-muted-foreground typography-ui-label">{t('opm.section.empty')}</p> : (
                  <div className="space-y-2">
                    {snapshot.tree.map((root: OpmTreeRow) => (
                      <div key={`${root.project}#${root.ref}`} className="space-y-2">
                        <OpmWorkRow row={root} onCopy={copyCommand} copiedCommand={copiedCommand} onOpenSession={openRowSession} />
                        {root.childRows.map((child) => <OpmWorkRow key={`${child.project}#${child.ref}`} row={child} nested onCopy={copyCommand} copiedCommand={copiedCommand} onOpenSession={openRowSession} />)}
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 typography-micro text-muted-foreground">
                <span>{t('opm.footer.counts', { needsYou: counts.needsYou, blocked: counts.blocked, working: counts.active, waiting: counts.waiting, queued: counts.queued })}</span>
                {notificationPermission === 'default' ? (
                  <Button size="xs" variant="outline" onClick={() => void requestNotifications()}>{t('opm.actions.enableNotifications')}</Button>
                ) : null}
              </footer>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
