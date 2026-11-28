import React from 'react';
import type { SessionGroup, SessionNode } from '../types';
import { anySessionOrDescendantIn, collectOpenTurnSessionIds, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { useBackgroundImagesStore } from '@/sync/background-images';
import { useWorkflowActivityStore } from '@/sync/workflow-activity';
import { usePrWatchStore } from '@/sync/pr-watch';
import { useExtensionWaitsStore } from '@/sync/extension-waits';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSessionUnread } from '@/sync/session-unread';

export type CollapsedActivityState = 'permission' | 'form' | 'failed' | 'active' | 'unread' | null;

const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_PR_WATCHES: ReturnType<typeof usePrWatchStore.getState>['bySession'] = new Map();
const EMPTY_EXTENSION_WAITS: ReturnType<typeof useExtensionWaitsStore.getState>['bySession'] = new Map();

export const collectGroupActivityNodes = (groups: readonly SessionGroup[]): SessionNode[] => {
  const nodes: SessionNode[] = [];
  for (const group of groups) {
    if (group.isArchivedBucket) continue;
    nodes.push(...group.sessions);
  }
  return nodes;
};

export const collectWorkEntryActivityNodes = (
  entries: readonly ({ kind: 'session'; item: { node: SessionNode } } | { kind: 'group'; group: SessionGroup } | { kind: 'draft' })[],
): SessionNode[] => {
  const nodes: SessionNode[] = [];
  for (const entry of entries) {
    if (entry.kind === 'session') nodes.push(entry.item.node);
    else if (entry.kind === 'group') nodes.push(...entry.group.sessions);
  }
  return nodes;
};

const mergeCollapsedActivityStates = (
  current: CollapsedActivityState,
  next: CollapsedActivityState,
): CollapsedActivityState => {
  if (current === 'active' || next === 'active') return 'active';
  if (current === 'unread' || next === 'unread') return 'unread';
  return null;
};

const getSessionNodeActivityState = (
  node: SessionNode,
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
): CollapsedActivityState => {
  if (activeSessionIds.has(node.session.id)) return 'active';

  let state: CollapsedActivityState = null;
  if (unreadSessionIds.has(node.session.id) && !node.session.parentID) state = 'unread';

  for (const child of node.children) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(child, activeSessionIds, unreadSessionIds),
    );
    if (state === 'active') return state;
  }

  return state;
};

export const getSessionNodesActivityState = (
  nodes: SessionNode[],
  activeSessionIds: Set<string>,
  unreadSessionIds: Set<string>,
): CollapsedActivityState => {
  let state: CollapsedActivityState = null;
  for (const node of nodes) {
    state = mergeCollapsedActivityStates(
      state,
      getSessionNodeActivityState(node, activeSessionIds, unreadSessionIds),
    );
    if (state === 'active') return state;
  }
  return state;
};

type SessionActivityProps = {
  nodes: readonly SessionNode[];
  blockingSessionIds?: readonly string[];
};

const collectActivityIds = (nodes: readonly SessionNode[]) => {
  const active = new Set<string>();
  const unread = new Set<string>();
  const visit = (node: SessionNode, isSubtask: boolean): void => {
    active.add(node.session.id);
    if (!isSubtask) unread.add(node.session.id);
    node.children.forEach((child) => visit(child, true));
  };
  nodes.forEach((node) => visit(node, false));
  return { active, unread };
};

export const useCollapsedSessionActivityState = ({
  nodes,
  blockingSessionIds,
  enabled = true,
}: SessionActivityProps & { enabled?: boolean }): CollapsedActivityState => {
  const ids = React.useMemo(() => collectActivityIds(enabled ? nodes : []), [enabled, nodes]);
  const blockingIds = React.useMemo(
    () => (blockingSessionIds && blockingSessionIds.length > 0 ? new Set([...ids.active, ...blockingSessionIds]) : ids.active),
    [blockingSessionIds, ids.active],
  );
  const activeIds = useGlobalSessionStatusStore((state) => (enabled ? state.activeSessionIds : EMPTY_IDS));
  const workflowIds = useWorkflowActivityStore((state) => (enabled ? state.runningSessionIds : EMPTY_IDS));
  const shellIds = useBackgroundShellsStore((state) => (enabled ? state.sessionIds : EMPTY_IDS));
  const imageIds = useBackgroundImagesStore((state) => (enabled ? state.sessionIds : EMPTY_IDS));
  const prWatches = usePrWatchStore((state) => (enabled ? state.bySession : EMPTY_PR_WATCHES));
  const extensionWaits = useExtensionWaitsStore((state) => (enabled ? state.bySession : EMPTY_EXTENSION_WAITS));
  const openTurnIds = React.useMemo(() => (
    enabled
      ? collectOpenTurnSessionIds(activeIds, [workflowIds, shellIds, imageIds, prWatches.keys(), extensionWaits.keys()])
      : EMPTY_IDS
  ), [activeIds, enabled, extensionWaits, imageIds, prWatches, shellIds, workflowIds]);
  const running: CollapsedActivityState = React.useMemo(() => (
    enabled && anySessionOrDescendantIn(ids.active, openTurnIds) ? 'active' : null
  ), [enabled, ids.active, openTurnIds]);
  const outcome = useGlobalSessionsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    let unread: CollapsedActivityState = null;
    for (const sessionId of ids.unread) {
      const session = state.entityById.get(sessionId);
      if (session?.outcome === 'failed' && !openTurnIds.has(sessionId)) return 'failed';
      if (isSessionUnread(session)) unread = 'unread';
    }
    return unread;
  }, [enabled, ids.unread, openTurnIds]));
  const blocked = useGlobalBlockingRequestsStore(React.useCallback((state): CollapsedActivityState => {
    if (!enabled) return null;
    let result: CollapsedActivityState = null;
    for (const sessionId of blockingIds) {
      const pending = state.bySession.get(sessionId);
      if (!pending) continue;
      if (pending.permissions.length > 0) return 'permission';
      if (pending.forms.length > 0 || pending.pages.length > 0) result = 'form';
    }
    return result;
  }, [enabled, blockingIds]));
  return blocked ?? (outcome === 'failed' ? 'failed' : null) ?? running ?? outcome;
};
