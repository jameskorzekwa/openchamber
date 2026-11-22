import type { Session } from '@/lib/opencode/model';

export type ArchiveBucket = {
  key: string;
  kind: 'project' | 'space' | 'other';
  label: string;
  directory: string;
  projectId?: string;
  sessions: Session[];
};

export const groupByParent = (sessions: Session[]): Session[] => {
  const byParent = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const siblings = byParent.get(session.parentID);
    if (siblings) siblings.push(session);
    else byParent.set(session.parentID, [session]);
  }
  const grouped: Session[] = [];
  const placedParents = new Set<string>();
  for (const session of sessions) {
    if (!session.parentID) {
      grouped.push(session);
      continue;
    }
    if (placedParents.has(session.parentID)) continue;
    placedParents.add(session.parentID);
    grouped.push(...(byParent.get(session.parentID) ?? []));
  }
  return grouped;
};
