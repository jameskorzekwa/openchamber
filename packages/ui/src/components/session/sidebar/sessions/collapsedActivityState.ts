import React from 'react';
import type { SessionGroup, SessionNode } from '../types';
import { collectOpenTurnSessionIds, useGlobalSessionStatusStore } from '@/sync/global-session-status';
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

export const collectGroupActivityNodes = (
  groups: readonly SessionGroup[],
  moved?: { projectId: string; movedSessionIds: ReadonlySet<string>; movedGroupKeys: ReadonlySet<string> },
): SessionNode[] => {
  const nodes: SessionNode[] = [];
  for (const group of groups) {
    if (group.isArchivedBucket) continue;
    if (moved && moved.movedGroupKeys.has(`${moved.projectId}:${group.id}`)) continue;
    for (const node of group.sessions) {
      if (moved?.movedSessionIds.has(node.session.id)) continue;
      nodes.push(node);
    }
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

const splitOpenTurnKeys = (keys: readonly string[]): string[] => keys.flatMap((key) => (key ? key.split('\n') : []));

const openTurnKeyWithin = (sessionIds: ReadonlySet<string>, candidates: Iterable<string>, earlierKeys: readonly string[]): string => {
  const earlier = new Set(splitOpenTurnKeys(earlierKeys));
  return [...collectOpenTurnSessionIds(EMPTY_IDS, [candidates])]
    .filter((sessionId) => sessionIds.has(sessionId) && !earlier.has(sessionId))
    .sort()
    .join('\n');
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
  const activeOpen = useGlobalSessionStatusStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.activeSessionIds, []) : ''
  ), [enabled, ids.active]));
  const workflowOpen = useWorkflowActivityStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.runningSessionIds, [activeOpen]) : ''
  ), [activeOpen, enabled, ids.active]));
  const shellOpen = useBackgroundShellsStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.sessionIds, [activeOpen, workflowOpen]) : ''
  ), [activeOpen, enabled, ids.active, workflowOpen]));
  const imageOpen = useBackgroundImagesStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.sessionIds, [activeOpen, workflowOpen, shellOpen]) : ''
  ), [activeOpen, enabled, ids.active, shellOpen, workflowOpen]));
  const prWatchOpen = usePrWatchStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.bySession.keys(), [activeOpen, workflowOpen, shellOpen, imageOpen]) : ''
  ), [activeOpen, enabled, ids.active, imageOpen, shellOpen, workflowOpen]));
  const extensionWaitOpen = useExtensionWaitsStore(React.useCallback((state) => (
    enabled ? openTurnKeyWithin(ids.active, state.bySession.keys(), [activeOpen, workflowOpen, shellOpen, imageOpen, prWatchOpen]) : ''
  ), [activeOpen, enabled, ids.active, imageOpen, prWatchOpen, shellOpen, workflowOpen]));
  const openTurnIds = React.useMemo(
    () => new Set(splitOpenTurnKeys([activeOpen, workflowOpen, shellOpen, imageOpen, prWatchOpen, extensionWaitOpen])),
    [activeOpen, extensionWaitOpen, imageOpen, prWatchOpen, shellOpen, workflowOpen],
  );
  const running: CollapsedActivityState = openTurnIds.size > 0 ? 'active' : null;
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
