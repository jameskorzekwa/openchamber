import { z } from 'zod';
import type { SettingsDocument } from './settings-helpers.js';

const sessionWorkSettingsSchema = z.object({
  sessionWorkEnabled: z.boolean().optional().catch(undefined),
  sessionWorkIncludesPinned: z.boolean().optional().catch(undefined),
  sessionWorkAutoDoneDays: z.number().int().min(0).max(365).optional().catch(undefined),
});

type SessionWorkSettings = z.infer<typeof sessionWorkSettingsSchema>;

export const sanitizeSessionWorkSettings = (candidate: SettingsDocument): SessionWorkSettings => {
  const { sessionWorkEnabled, sessionWorkIncludesPinned, sessionWorkAutoDoneDays } = sessionWorkSettingsSchema.parse(candidate);
  const result: SessionWorkSettings = {};
  if (sessionWorkEnabled !== undefined) result.sessionWorkEnabled = sessionWorkEnabled;
  if (sessionWorkIncludesPinned !== undefined) result.sessionWorkIncludesPinned = sessionWorkIncludesPinned;
  if (sessionWorkAutoDoneDays !== undefined) result.sessionWorkAutoDoneDays = sessionWorkAutoDoneDays;
  return result;
};

export const sessionWorkResponseFields = ({ sessionWorkIncludesPinned, sessionWorkAutoDoneDays }: SessionWorkSettings) => ({
  sessionWorkIncludesPinned: sessionWorkIncludesPinned ?? false,
  sessionWorkAutoDoneDays: sessionWorkAutoDoneDays ?? 0,
});
