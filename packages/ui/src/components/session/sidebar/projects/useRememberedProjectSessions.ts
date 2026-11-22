import React from 'react';
import { z } from 'zod';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const activeSessionByProjectSchema = z.record(z.string(), z.string().min(1).catch(''));

export function useRememberedProjectSessions() {
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const initialActiveSessionByProject = React.useMemo<Map<string, string>>(() => {
    try {
      const raw = safeStorage.getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = activeSessionByProjectSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return new Map();
      const next = new Map<string, string>();
      Object.entries(parsed.data).forEach(([projectId, sessionId]) => {
        if (sessionId) next.set(projectId, sessionId);
      });
      return next;
    } catch {
      return new Map();
    }
  }, [safeStorage]);
  const persistActiveSessionByProject = React.useCallback((value: Map<string, string>) => {
    try {
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(value.entries())));
    } catch {
      return;
    }
  }, [safeStorage]);

  return { initialActiveSessionByProject, persistActiveSessionByProject };
}
