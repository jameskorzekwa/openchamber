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
  getTotalOpmCount,
  openOpmRowSession,
  ownerGuidanceKind,
  postOpmCommand,
  type OpmAvailableSnapshot,
  type OpmCommandResult,
  type OpmRow,
  type OpmSnapshot,
  type OpmStatusLoadResult,
  type OpmTreeRow,
} from './opm-status';

const POLL_INTERVAL_MS = 15_000;
const SENT_RESET_MS = 10_000;
const NOTIFIED_KEY = 'opmStatus.notified';
const OPM_DIALOG_CLASS = 'oc-opm-dialog-open';
const notifiedKeysSchema = z.array(z.string());

// The pill lives on the outer edge, wherever the owner drags it. The position
// is stored as (edge, fractional offset along that edge) so it survives
// resizes and viewport changes; inline styles override the default CSS
// position only when a stored position exists.
const PILL_POS_KEY = 'opmStatus.pillPos';
const PILL_EDGE_MARGIN = 6;
const PILL_DRAG_THRESHOLD_PX = 5;

const pillPositionSchema = z.object({
  edge: z.enum(['left', 'right', 'top', 'bottom']),
  offset: z.number().min(0).max(1),
});
type PillPosition = z.infer<typeof pillPositionSchema>;

const readPillPosition = (): PillPosition | null => {
  try {
    const parsed = pillPositionSchema.safeParse(JSON.parse(localStorage.getItem(PILL_POS_KEY) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const writePillPosition = (position: PillPosition) => {
  try {
    localStorage.setItem(PILL_POS_KEY, JSON.stringify(position));
  } catch {
    // Local storage is optional.
  }
};

const applyPillPosition = (pill: HTMLElement, position: PillPosition | null) => {
  if (!position) return;
  const rect = pill.getBoundingClientRect();
  const width = rect.width || 90;
  const height = rect.height || 30;
  const maxX = Math.max(0, window.innerWidth - width - PILL_EDGE_MARGIN * 2);
  const maxY = Math.max(0, window.innerHeight - height - PILL_EDGE_MARGIN * 2);
  pill.style.left = pill.style.right = pill.style.top = pill.style.bottom = 'auto';
  if (position.edge === 'left' || position.edge === 'right') {
    pill.style[position.edge] = `${PILL_EDGE_MARGIN}px`;
    pill.style.top = `${Math.round(PILL_EDGE_MARGIN + position.offset * maxY)}px`;
  } else {
    pill.style[position.edge] = position.edge === 'top'
      ? `calc(env(safe-area-inset-top, 0px) + ${PILL_EDGE_MARGIN}px)`
      : `${PILL_EDGE_MARGIN}px`;
    pill.style.left = `${Math.round(PILL_EDGE_MARGIN + position.offset * maxX)}px`;
  }
};

const snapPillToEdge = (pill: HTMLElement, x: number, y: number): PillPosition => {
  const rect = pill.getBoundingClientRect();
  const width = rect.width || 90;
  const height = rect.height || 30;
  const distances = {
    left: x,
    right: window.innerWidth - (x + width),
    top: y,
    bottom: window.innerHeight - (y + height),
  };
  const edges: Array<keyof typeof distances> = ['left', 'right', 'top', 'bottom'];
  const edge = edges.reduce((a, b) => (distances[a] <= distances[b] ? a : b));
  const maxX = Math.max(1, window.innerWidth - width - PILL_EDGE_MARGIN * 2);
  const maxY = Math.max(1, window.innerHeight - height - PILL_EDGE_MARGIN * 2);
  const offset = (edge === 'left' || edge === 'right')
    ? Math.min(1, Math.max(0, (y - PILL_EDGE_MARGIN) / maxY))
    : Math.min(1, Math.max(0, (x - PILL_EDGE_MARGIN) / maxX));
  return { edge, offset };
};

// Pointer-based drag along the viewport edges. A 5px travel threshold keeps
// plain taps opening the dashboard; anything past it drags freely and snaps
// to the nearest edge on release. The release also suppresses the click that
// browsers fire after pointerup, so a drag never opens the dashboard.
const usePillDrag = () => {
  const pillRef = React.useRef<HTMLButtonElement | null>(null);
  const dragStateRef = React.useRef<{ startX: number; startY: number; dx: number; dy: number } | null>(null);
  const dragMovedRef = React.useRef(false);

  // The pill mounts only after the first successful poll, so the stored
  // position is applied from the callback ref rather than a mount effect.
  const attachPill = React.useCallback((node: HTMLButtonElement | null) => {
    pillRef.current = node;
    if (node) applyPillPosition(node, readPillPosition());
  }, []);

  React.useEffect(() => {
    const handleResize = () => {
      if (pillRef.current) applyPillPosition(pillRef.current, readPillPosition());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    dragMovedRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (!dragMovedRef.current) {
      const travel = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
      if (travel < PILL_DRAG_THRESHOLD_PX) return;
      dragMovedRef.current = true;
    }
    // Once a drag is recognized, keep iOS from scrolling underneath it.
    if (event.nativeEvent.cancelable) event.preventDefault();
    const pill = event.currentTarget;
    pill.style.left = `${event.clientX - state.dx}px`;
    pill.style.top = `${event.clientY - state.dy}px`;
    pill.style.right = pill.style.bottom = 'auto';
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragStateRef.current) return;
    dragStateRef.current = null;
    if (!dragMovedRef.current) return;
    const pill = event.currentTarget;
    const rect = pill.getBoundingClientRect();
    const position = snapPillToEdge(pill, rect.left, rect.top);
    writePillPosition(position);
    applyPillPosition(pill, position);
    // Suppress the click that follows a drag release.
    window.setTimeout(() => {
      dragMovedRef.current = false;
    }, 0);
  };

  return { attachPill, dragMovedRef, onPointerDown, onPointerMove, onPointerEnd };
};

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

const stateLabel = (state: string | null, t: Translate) => {
  switch (state) {
    case 'planned': return t('opm.phase.planned');
    case 'implemented': return t('opm.state.implemented');
    case 'reviewed': return t('opm.state.reviewed');
    case 'merged': return t('opm.phase.merged');
    case 'deployed': return t('opm.phase.deployed');
    case 'verified': return t('opm.phase.verified');
    case 'completed': return t('opm.phase.completed');
    case 'cancelled': return t('opm.phase.cancelled');
    case 'failed': return t('opm.phase.failed');
    default: return state?.replaceAll('_', ' ') || t('common.unavailable');
  }
};

const actionLabel = (action: string | null, t: Translate) => {
  switch (action) {
    case 'queued': return t('opm.action.queued');
    case 'planning': return t('opm.action.planning');
    case 'active': return t('opm.action.active');
    case 'reviewing': return t('opm.action.reviewing');
    case 'merging': return t('opm.action.merging');
    case 'deploying': return t('opm.action.deploying');
    case 'verifying': return t('opm.action.verifying');
    case 'remediating': return t('opm.action.remediating');
    case 'closing': return t('opm.action.closing');
    case 'waiting_external': return t('opm.action.waitingExternal');
    case 'waiting_owner': return t('opm.action.waitingOwner');
    case 'paused': return t('opm.action.paused');
    case 'blocked': return t('opm.action.blocked');
    case 'idle': return t('opm.action.idle');
    default: return action?.replaceAll('_', ' ') || t('common.unavailable');
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

const stateTone = (row: OpmRow) => {
  if (row.state === 'failed' || row.state === 'cancelled') return 'text-status-error bg-status-error/10';
  if (row.state === 'completed' || row.state === 'verified' || row.state === 'deployed') return 'text-status-success bg-status-success/10';
  return 'text-status-info bg-status-info/10';
};

const actionTone = (row: OpmRow) => {
  if (row.action === 'waiting_owner') return 'text-status-error bg-status-error/10';
  if (row.action === 'blocked' || row.action === 'paused') return 'text-status-warning bg-status-warning/10';
  if (row.action === 'idle' || row.action === 'queued') return 'text-muted-foreground bg-[var(--surface-muted)]';
  if (row.action === 'waiting_external') return 'text-status-info bg-status-info/10';
  return 'text-status-success bg-status-success/10';
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

type RunState =
  | { status: 'pending' }
  | { status: 'sent' }
  | { status: 'error'; message: string };

const OpmWorkRow = ({
  row,
  isParent,
  isChild,
  onCopy,
  copiedCommand,
  onOpenSession,
  runState,
  onRun,
  expanded,
  onToggleExpand,
  childrenExpanded,
  onToggleChildren,
}: {
  row: OpmRow;
  isParent: boolean;
  isChild: boolean;
  onCopy: (command: string) => void;
  copiedCommand: string | null;
  onOpenSession: (row: OpmRow) => void;
  runState: RunState | undefined;
  onRun: (row: OpmRow) => void;
  expanded: boolean;
  onToggleExpand: (row: OpmRow) => void;
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
}) => {
  const { locale, t } = useI18n();
  const projectLabel = `${row.projectName || row.project || 'OPM'} #${row.ref}`;
  const statusPills = (
    <span className="flex max-w-40 shrink-0 flex-col items-stretch gap-0.5">
      <span data-testid="opm-row-state" className={cn('flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 typography-micro', stateTone(row))}>
        <span className="shrink-0 opacity-70">{t('opm.row.state')}</span>
        <span className="min-w-0 truncate font-medium">{stateLabel(row.state, t)}</span>
      </span>
      <span data-testid="opm-row-action" className={cn('flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 typography-micro', actionTone(row))}>
        <span className="shrink-0 opacity-70">{t('opm.row.action')}</span>
        <span className="min-w-0 truncate font-medium">{actionLabel(row.action, t)}</span>
      </span>
    </span>
  );
  return (
    <article className={cn(
      'min-w-0 overflow-hidden rounded-md border px-1.5 py-0.5',
      rowTone(row),
      isChild && 'ml-2 rounded-l-none border-l-2',
    )}>
      <div className="flex min-w-0 items-center gap-1">
        {isParent ? (
          <button
            type="button"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            aria-label={childrenExpanded ? t('opm.actions.collapseSubtasks') : t('opm.actions.expandSubtasks')}
            aria-expanded={childrenExpanded}
            onClick={onToggleChildren}
          >
            <Icon name="arrow-right-s" className={cn('size-4 transition-transform', childrenExpanded && 'rotate-90')} />
          </button>
        ) : <span className="w-1 shrink-0" />}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          onClick={() => onToggleExpand(row)}
        >
          <span className="min-w-0 flex-1">
            <span data-testid="opm-row-title" className="block min-w-0 truncate font-medium leading-4 text-foreground">{row.title}</span>
            <span className="flex min-w-0 items-center gap-1 leading-4 typography-micro text-muted-foreground">
              <span data-testid="opm-row-reference" className="min-w-0 truncate">{projectLabel}</span>
              {isParent ? <span className="shrink-0">· {t('opm.row.parent')}</span> : null}
              {isChild ? <span className="shrink-0">· {t('opm.row.child')}</span> : null}
              <span className="shrink-0">· {relativeAge(row.updatedAt, locale)}</span>
            </span>
          </span>
          {statusPills}
          <Icon name="arrow-right-s" className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        </button>
      </div>
      <div data-testid="opm-row-detail" className={cn('min-w-0 pl-7', expanded ? 'mt-1.5 block' : 'hidden')}>
        {row.url ? (
          <a className="inline-flex min-w-0 max-w-full items-center gap-1 typography-micro text-muted-foreground hover:underline" href={row.url} target="_blank" rel="noreferrer">
            <span className="min-w-0 truncate">{projectLabel}</span><Icon name="external-link" className="size-3 shrink-0" />
          </a>
        ) : null}
        {row.parentRef ? <p className="mt-1 typography-micro text-muted-foreground">{t('opm.row.childOf', { ref: row.parentRef })}</p> : null}
        {row.reason ? <p className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] typography-ui-label text-muted-foreground">{row.reason}</p> : null}
        {row.nextAction && row.nextAction !== row.reason ? <p className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] typography-ui-label text-muted-foreground">{t('opm.row.nextAction', { action: row.nextAction })}</p> : null}
        <div className={cn(
          'mt-1.5 min-w-0 break-words rounded-md px-2 py-1.5 typography-ui-label',
          row.owner.required ? 'bg-status-error/10 text-status-error' : 'bg-status-success/10 text-status-success',
        )}>
          {ownerText(row, t)}
        </div>
        <div className="mt-1.5 min-w-0 space-y-1.5">
          {row.command ? (
            <code className="block w-full min-w-0 whitespace-pre-wrap break-all rounded-md bg-background px-2 py-1.5 typography-micro text-foreground">{row.command}</code>
          ) : null}
          {(row.command || row.sessionId) ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {row.command ? (
                <>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={runState?.status === 'pending' || runState?.status === 'sent'}
                    onClick={() => onRun(row)}
                  >
                    {runState?.status === 'pending'
                      ? t('opm.actions.running')
                      : runState?.status === 'sent'
                        ? t('opm.actions.sent')
                        : t('opm.actions.run')}
                  </Button>
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
          ) : null}
        </div>
        {runState?.status === 'error' ? (
          <p className="mt-1 min-w-0 break-words typography-micro text-status-error" role="alert">{runState.message}</p>
        ) : null}
        {(row.branch || row.sessionId || row.effect) ? (
          <p className="mt-2 min-w-0 break-all font-mono typography-micro text-muted-foreground">
            {[row.branch && t('opm.row.branch', { branch: row.branch }), row.sessionId && t('opm.row.session', { session: row.sessionId }), row.effect?.kind && t('opm.row.effect', { kind: row.effect.kind, status: row.effect.status ?? '' })].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {row.effect?.error ? <p className="mt-1 min-w-0 break-words [overflow-wrap:anywhere] typography-micro text-status-error">{row.effect.error}</p> : null}
      </div>
    </article>
  );
};

const TaskOverview = ({ snapshot }: { snapshot: OpmAvailableSnapshot }) => {
  const { t } = useI18n();
  const counts = getOpmCounts(snapshot);
  const total = getTotalOpmCount(snapshot) ?? 0;
  const states = [
    { label: phaseLabel('waiting_owner', t), count: counts.needsYou, tone: 'text-status-error bg-status-error/10' },
    { label: phaseLabel('blocked', t), count: counts.blocked, tone: 'text-status-warning bg-status-warning/10' },
    { label: phaseLabel('active', t), count: counts.active, tone: 'text-status-success bg-status-success/10' },
    { label: phaseLabel('waiting_external', t), count: counts.waiting, tone: 'text-status-info bg-status-info/10' },
    { label: t('opm.overview.queued'), count: counts.queued, tone: 'text-muted-foreground bg-[var(--surface-muted)]' },
  ];
  return (
    <section aria-labelledby="opm-task-overview" data-testid="opm-task-overview" className="min-w-0 rounded-md border border-border/60 bg-[var(--surface-elevated)] px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h3 id="opm-task-overview" className="font-medium text-foreground">{t('opm.section.workItems')}</h3>
        <span data-testid="opm-task-total" className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 font-medium typography-micro text-foreground">{total}</span>
        {states.map((state) => (
          <span key={state.label} className={cn('inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 typography-micro', state.tone)}>
            <span className="font-semibold">{state.count}</span>
            <span className="truncate">{state.label}</span>
          </span>
        ))}
      </div>
    </section>
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
    <details className="min-w-0 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-2.5 py-2">
      <summary className="cursor-pointer select-none font-medium text-foreground typography-ui-label">
        {t('opm.supervisor.title')} · {supervisor.running ? t('opm.supervisor.running') : t('opm.supervisor.stopped')}
      </summary>
      <section aria-label={t('opm.supervisor.title')} className="mt-2 min-w-0">
      <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 typography-ui-label text-muted-foreground">
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
    </details>
  );
};

const rowKey = (row: OpmRow) => `${row.project}#${row.ref}`;

const hierarchyPriority = (row: OpmTreeRow): number => {
  const ownPriority = row.owner.required || row.kind
    ? 0
    : row.activityState === 'working'
      ? 1
      : row.phase === 'blocked' || row.phase === 'failed' || row.phase === 'paused'
        ? 2
        : row.activityState === 'queued'
          ? 4
          : 3;
  return Math.min(ownPriority, ...row.childRows.map(hierarchyPriority));
};

const prioritizeHierarchy = (rows: OpmTreeRow[]): OpmTreeRow[] => [...rows]
  .sort((left, right) => hierarchyPriority(left) - hierarchyPriority(right))
  .map((row) => ({ ...row, childRows: prioritizeHierarchy(row.childRows) }));

export const OpmStatusOverlay = ({
  loadStatus = fetchOpmStatus,
  openSession = (sessionId, workspacePath) => useSessionUIStore.getState().setCurrentSession(sessionId, workspacePath),
  sendCommand = postOpmCommand,
}: {
  loadStatus?: () => Promise<OpmStatusLoadResult>;
  openSession?: (sessionId: string, workspacePath: string | null) => void;
  sendCommand?: (row: OpmRow) => Promise<OpmCommandResult>;
}) => {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = React.useState<OpmSnapshot | null>(null);
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [open, setOpen] = React.useState(false);
  const [copiedCommand, setCopiedCommand] = React.useState<string | null>(null);
  const [runStates, setRunStates] = React.useState<Record<string, RunState>>({});
  // Details stay collapsed until the owner opens them. Every summary remains
  // visible, including children, so the dashboard is useful at a glance.
  const [expandedOverrides, setExpandedOverrides] = React.useState<Record<string, boolean>>({});
  const [childrenExpandedOverrides, setChildrenExpandedOverrides] = React.useState<Record<string, boolean>>({});
  const [notificationPermission, setNotificationPermission] = React.useState<NotificationPermission | 'unsupported'>(
    globalThis.Notification ? Notification.permission : 'unsupported',
  );
  const { attachPill, dragMovedRef, onPointerDown, onPointerMove, onPointerEnd } = usePillDrag();

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

  React.useEffect(() => {
    if (!open) return;
    document.documentElement.classList.add(OPM_DIALOG_CLASS);
    return () => document.documentElement.classList.remove(OPM_DIALOG_CLASS);
  }, [open]);

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
  const pillCount = getTotalOpmCount(snapshot);

  const copyCommand = (command: string) => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopiedCommand(command);
      window.setTimeout(() => setCopiedCommand(null), 1_500);
    });
  };
  const openRowSession = (row: OpmRow) => {
    if (openOpmRowSession(row, openSession)) setOpen(false);
  };
  const isRowExpanded = (row: OpmRow, defaultExpanded = false) => expandedOverrides[rowKey(row)] ?? defaultExpanded;
  const toggleRow = (row: OpmRow, defaultExpanded = false) => {
    const next = !isRowExpanded(row, defaultExpanded);
    setExpandedOverrides((previous) => ({ ...previous, [rowKey(row)]: next }));
  };
  const areChildrenExpanded = (row: OpmRow) => childrenExpandedOverrides[rowKey(row)] ?? true;
  const toggleChildren = (row: OpmRow) => {
    setChildrenExpandedOverrides((previous) => ({ ...previous, [rowKey(row)]: !areChildrenExpanded(row) }));
  };
  const runCommand = async (row: OpmRow) => {
    const key = rowKey(row);
    setRunStates((previous) => ({ ...previous, [key]: { status: 'pending' } }));
    const result = await sendCommand(row);
    if (result.ok) {
      setRunStates((previous) => ({ ...previous, [key]: { status: 'sent' } }));
      window.setTimeout(() => {
        setRunStates((previous) => {
          const rest = { ...previous };
          delete rest[key];
          return rest;
        });
      }, SENT_RESET_MS);
    } else {
      setRunStates((previous) => ({ ...previous, [key]: { status: 'error', message: result.error } }));
    }
  };
  const rowProps = (row: OpmRow, isParent: boolean, isChild: boolean, defaultExpanded = false) => ({
    row,
    isParent,
    isChild,
    onCopy: copyCommand,
    copiedCommand,
    onOpenSession: openRowSession,
    runState: runStates[rowKey(row)],
    onRun: (target: OpmRow) => void runCommand(target),
    expanded: isRowExpanded(row, defaultExpanded),
    onToggleExpand: (target: OpmRow) => toggleRow(target, defaultExpanded),
    childrenExpanded: isParent ? areChildrenExpanded(row) : undefined,
    onToggleChildren: isParent ? () => toggleChildren(row) : undefined,
  });
  const renderHierarchy = (rows: OpmTreeRow[], depth = 0): React.ReactNode => rows.map((row) => {
    const children = row.childRows;
    const childrenExpanded = areChildrenExpanded(row);
    return (
      <div key={rowKey(row)} className="min-w-0 space-y-1">
        <OpmWorkRow {...rowProps(row, children.length > 0, depth > 0)} />
        {children.length > 0 && childrenExpanded ? (
          <div className="min-w-0 space-y-1">{renderHierarchy(children, depth + 1)}</div>
        ) : null}
      </div>
    );
  });
  const prioritizedTree = snapshot.available ? prioritizeHierarchy(snapshot.tree) : [];
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
        ref={attachPill}
        aria-label={t('opm.pill.aria')}
        aria-haspopup="dialog"
        aria-expanded={open}
        variant="outline"
        size="sm"
        className={cn(
          'fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-3 z-40 rounded-full bg-[var(--surface-elevated)] shadow-none',
          // iOS drag support: the pill is always the pointer target, and no
          // child ever starts a text-selection or callout during a drag.
          'touch-none select-none [-webkit-touch-callout:none] [-webkit-user-select:none]',
          '[&_*]:pointer-events-none [&_*]:select-none [&_*]:[-webkit-touch-callout:none] [&_*]:[-webkit-user-select:none]',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={() => {
          if (dragMovedRef.current) return;
          setOpen(true);
        }}
      >
        <StatusDot snapshot={snapshot} />
        <span className="hidden sm:inline">{pillText}</span>
        {pillCount !== null ? (
          <span data-testid="opm-pill-total" className="rounded-full bg-[var(--surface-muted)] px-1.5 font-bold">
            {pillCount}
          </span>
        ) : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-w-4xl gap-0 overflow-x-hidden p-0 pb-[max(1rem,env(safe-area-inset-bottom))] max-sm:fixed max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:border-0 [@media(max-height:500px)]:fixed [@media(max-height:500px)]:inset-0 [@media(max-height:500px)]:h-[100dvh] [@media(max-height:500px)]:max-h-[100dvh] [@media(max-height:500px)]:w-screen [@media(max-height:500px)]:max-w-none [@media(max-height:500px)]:rounded-none [@media(max-height:500px)]:border-0"
        >
          {/* The popup itself scrolls, so the header is sticky, opaque, and
              z-raised: body content scrolls under it, never over the title or
              the close button. The close button lives inside this bar for the
              same reason. */}
          <DialogHeader className="sticky top-0 z-30 min-w-0 shrink-0 gap-1 border-b border-border/60 bg-background pb-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] text-left sm:pb-3 sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pt-[max(1.25rem,env(safe-area-inset-top))]">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <DialogTitle className="flex min-w-0 items-center gap-2"><StatusDot snapshot={snapshot} />OPM</DialogTitle>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('dialog.common.actions.close')}
                className="app-region-no-drag pointer-events-auto relative z-50 -mr-1 shrink-0 touch-manipulation"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                }}
                onClick={() => setOpen(false)}
              >
                <Icon name="close" className="size-4" />
              </Button>
            </div>
            <DialogDescription className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
              {snapshot.available
                ? `${phaseLabel(snapshot.state, t)} · ${snapshot.summary || t('opm.dialog.noSummary')} · ${t('opm.dialog.updated', { age: relativeAge(snapshot.fetchedAt, locale) })}`
                : t('opm.dialog.unavailable')}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 overflow-x-hidden pb-1 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-2.5 sm:pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pt-3">
            {!snapshot.available ? (
              <div className="rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-status-warning typography-ui-label">
                {t('opm.dialog.controlUnreachable')}
              </div>
            ) : (
              <div className="space-y-2">
                {snapshot.groups.needsYou.length > 0 ? (
                  <section aria-labelledby="opm-needs-you" data-testid="opm-needs-you" className="min-w-0 rounded-md border border-status-error/40 bg-status-error/5 p-1.5">
                    <h3 id="opm-needs-you" className="mb-1 px-1 font-semibold text-status-error typography-ui-label">
                      {t('opm.section.needsYou', { count: snapshot.groups.needsYou.length })}
                    </h3>
                    <div className="min-w-0 space-y-1">
                      {snapshot.groups.needsYou.map((row) => (
                        <OpmWorkRow key={`attention:${rowKey(row)}`} {...rowProps(row, false, Boolean(row.parentRef), true)} />
                      ))}
                    </div>
                  </section>
                ) : null}
                <TaskOverview snapshot={snapshot} />
                <section aria-labelledby="opm-work-items">
                  <h3 id="opm-work-items" className="sr-only">{t('opm.section.workItems')}</h3>
                  {snapshot.tree.length === 0 ? <p className="text-muted-foreground typography-ui-label">{t('opm.section.empty')}</p> : (
                    <div data-testid="opm-work-tree" className="min-w-0 space-y-1.5">{renderHierarchy(prioritizedTree)}</div>
                  )}
                </section>
                <SupervisorSummary snapshot={snapshot} />
                {notificationPermission === 'default' ? (
                  <footer className="flex justify-end border-t border-border/60 pt-3">
                    <Button size="xs" variant="outline" onClick={() => void requestNotifications()}>{t('opm.actions.enableNotifications')}</Button>
                  </footer>
                ) : null}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
