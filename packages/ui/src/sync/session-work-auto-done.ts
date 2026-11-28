import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { getSessionWork, isSessionInWork } from '@/lib/sessionWorkMetadata';
import { isSessionPinned, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBackgroundImagesStore } from './background-images';
import { useBackgroundShellsStore } from './background-shells';
import { useExtensionWaitsStore } from './extension-waits';
import { hasHostBlockingSnapshot, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import {
  collectOpenTurnSessionIds,
  collectSessionAndAncestorIds,
  useGlobalSessionStatusStore,
} from './global-session-status';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { usePrWatchStore } from './pr-watch';
import { setSessionWorkState } from './session-actions';
import { useSessionUIStore } from './session-ui-store';
import { useWorkflowActivityStore } from './workflow-activity';

const DAY_MS = 86_400_000;
const WORK_AUTO_DONE_INTERVAL_MS = 60 * 60_000;
export const SESSION_WORK_AUTO_DONE_DAY_OPTIONS = [0, 3, 7, 14, 30] as const;

const finiteTime = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

const lastWorkActivityTime = (session: Session): number => Math.max(
  finiteTime(session.time?.idle),
  finiteTime(session.time?.updated),
  finiteTime(session.time?.created),
  finiteTime(getSessionWork(session)?.openedAt),
);

type AutoDoneCandidateOptions = {
  sessions: readonly Session[];
  currentSessionId: string | null;
  autoDoneDays: number;
  activeSessionIds: ReadonlySet<string>;
  blockingSessionIds: ReadonlySet<string>;
  isPinned?: (session: Session) => boolean;
  now?: number;
};

const isSessionEligibleForAutoDone = (
  session: Session,
  cutoff: number,
  protectedIds: ReadonlySet<string>,
  isPinned?: (session: Session) => boolean,
): boolean => {
  if (session.parentID || session.time?.archived !== undefined) return false;
  if (!isSessionInWork(session)) return false;
  if (protectedIds.has(session.id)) return false;
  if (isPinned?.(session)) return false;
  const lastActivity = lastWorkActivityTime(session);
  return lastActivity > 0 && lastActivity < cutoff;
};

const expandProtectedIds = (
  currentSessionId: string | null,
  activeSessionIds: ReadonlySet<string>,
  blockingSessionIds: ReadonlySet<string>,
): Set<string> => {
  const protectedIds = new Set<string>();
  const addWithAncestors = (sessionId: string): void => {
    for (const id of collectSessionAndAncestorIds(sessionId)) protectedIds.add(id);
  };
  if (currentSessionId) addWithAncestors(currentSessionId);
  for (const id of activeSessionIds) addWithAncestors(id);
  for (const id of blockingSessionIds) addWithAncestors(id);
  return protectedIds;
};

export function buildInWorkAutoDoneCandidates({
  sessions,
  currentSessionId,
  autoDoneDays,
  activeSessionIds,
  blockingSessionIds,
  isPinned,
  now = Date.now(),
}: AutoDoneCandidateOptions): Session[] {
  if (!Number.isFinite(autoDoneDays) || autoDoneDays < 1) return [];
  const cutoff = now - autoDoneDays * DAY_MS;
  const protectedIds = expandProtectedIds(currentSessionId, activeSessionIds, blockingSessionIds);
  return sessions.filter((session) => isSessionEligibleForAutoDone(session, cutoff, protectedIds, isPinned));
}

const collectLiveProtectionSnapshot = () => {
  const activeIds = useGlobalSessionStatusStore.getState().activeSessionIds;
  const openTurnIds = collectOpenTurnSessionIds(activeIds, [
    useWorkflowActivityStore.getState().runningSessionIds,
    useBackgroundShellsStore.getState().sessionIds,
    useBackgroundImagesStore.getState().sessionIds,
    usePrWatchStore.getState().bySession.keys(),
    useExtensionWaitsStore.getState().bySession.keys(),
  ]);
  const blockingSessionIds = new Set<string>();
  for (const [sessionId, pending] of useGlobalBlockingRequestsStore.getState().bySession) {
    if (pending.permissions.length > 0 || pending.forms.length > 0 || pending.pages.length > 0) {
      blockingSessionIds.add(sessionId);
    }
  }
  const pinnedIds = useSessionPinnedStore.getState().ids;
  return {
    currentSessionId: useSessionUIStore.getState().currentSessionId,
    activeSessionIds: openTurnIds,
    blockingSessionIds,
    isPinned: (session: Session) => isSessionPinnedInMetadata(session) || isSessionPinned(pinnedIds, session.directory, session.id),
  };
};

let inFlight = false;
let lastRunRuntimeKey: string | null = null;
let lastRunAt = 0;

export const resetSessionWorkAutoDoneCooldown = (): void => {
  lastRunAt = 0;
  lastRunRuntimeKey = null;
};

subscribeRuntimeEndpointWillChange(() => {
  resetSessionWorkAutoDoneCooldown();
  if (useUIStore.getState().sessionWorkAutoDoneDays !== 0) {
    useUIStore.setState({ sessionWorkAutoDoneDays: 0 });
  }
});

export const isSessionWorkAutoDoneDue = (now = Date.now()): boolean => (
  lastRunRuntimeKey !== getRuntimeKey() || now - lastRunAt >= WORK_AUTO_DONE_INTERVAL_MS
);

export type SessionWorkAutoDoneResult = {
  completedIds: string[];
  failedIds: string[];
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'running' | 'not-ready' | 'no-candidates' | 'runtime-changed';
};

export async function runSessionWorkAutoDone({ force = false, now = Date.now() } = {}): Promise<SessionWorkAutoDoneResult> {
  const result: SessionWorkAutoDoneResult = { completedIds: [], failedIds: [] };
  if (inFlight) return { ...result, skippedReason: 'running' };
  const settings = useUIStore.getState();
  if (!settings.sessionWorkEnabled || !Number.isFinite(settings.sessionWorkAutoDoneDays) || settings.sessionWorkAutoDoneDays < 1) {
    return { ...result, skippedReason: 'disabled' };
  }
  if (!force && useSessionUIStore.getState().isLoading) return { ...result, skippedReason: 'loading' };
  if (!force && !isSessionWorkAutoDoneDue(now)) return { ...result, skippedReason: 'cooldown' };

  const globalSessions = useGlobalSessionsStore.getState();
  if (globalSessions.status !== 'ready') return { ...result, skippedReason: 'not-ready' };

  const runtimeKey = getRuntimeKey();
  let runtimeChanged = false;
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => { runtimeChanged = true; });
  const isCurrentRuntime = () => !runtimeChanged && getRuntimeKey() === runtimeKey;

  inFlight = true;
  try {
    if (!hasHostBlockingSnapshot()) {
      await seedGlobalSessionStatusFromHost().catch(() => undefined);
    }
    if (!isCurrentRuntime()) return { ...result, skippedReason: 'runtime-changed' };
    if (!hasHostBlockingSnapshot()) return { ...result, skippedReason: 'not-ready' };

    const initialProtection = collectLiveProtectionSnapshot();
    const candidates = buildInWorkAutoDoneCandidates({
      sessions: useGlobalSessionsStore.getState().activeSessions,
      autoDoneDays: useUIStore.getState().sessionWorkAutoDoneDays,
      ...initialProtection,
      now,
    });

    if (candidates.length === 0) {
      lastRunRuntimeKey = runtimeKey;
      lastRunAt = now;
      return { ...result, skippedReason: 'no-candidates' };
    }

    for (const candidate of candidates) {
      if (!isCurrentRuntime()) return { ...result, skippedReason: 'runtime-changed' };
      const liveSettings = useUIStore.getState();
      if (!liveSettings.sessionWorkEnabled || !Number.isFinite(liveSettings.sessionWorkAutoDoneDays) || liveSettings.sessionWorkAutoDoneDays < 1) {
        break;
      }
      const liveSession = useGlobalSessionsStore.getState().entityById.get(candidate.id);
      if (!liveSession) continue;
      const liveProtection = collectLiveProtectionSnapshot();
      const cutoff = now - liveSettings.sessionWorkAutoDoneDays * DAY_MS;
      const protectedIds = expandProtectedIds(
        liveProtection.currentSessionId,
        liveProtection.activeSessionIds,
        liveProtection.blockingSessionIds,
      );
      if (!isSessionEligibleForAutoDone(liveSession, cutoff, protectedIds, liveProtection.isPinned)) continue;

      try {
        const updated = await setSessionWorkState(liveSession.id, resolveGlobalSessionDirectory(liveSession), 'done');
        if (updated) result.completedIds.push(liveSession.id);
      } catch {
        result.failedIds.push(liveSession.id);
      }
    }

    if (isCurrentRuntime()) {
      lastRunRuntimeKey = runtimeKey;
      lastRunAt = now;
    }
    return result;
  } finally {
    inFlight = false;
    unsubscribe();
  }
}
