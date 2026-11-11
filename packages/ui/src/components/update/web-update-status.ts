import { z } from 'zod';

export type WebUpdateInstallationState =
  | 'available'
  | 'downloading'
  | 'installing'
  | 'restarting'
  | 'installed'
  | 'failed'
  | 'rollback'
  | 'no-validated-release';

export type WebUpdateInstallationStatus = {
  schemaVersion: 1;
  state: WebUpdateInstallationState;
  currentVersion: string;
  targetVersion: string | null;
  previousVersion: string | null;
  error: string | null;
  updatedAt: string;
};

const webUpdateInstallationStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['available', 'downloading', 'installing', 'restarting', 'installed', 'failed', 'rollback', 'no-validated-release']),
  currentVersion: z.string(),
  targetVersion: z.string().nullable(),
  previousVersion: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
}).strict();

type WebUpdateInstallationPayload = z.input<typeof webUpdateInstallationStatusSchema>;

export function parseWebUpdateInstallationStatus(value: WebUpdateInstallationPayload): WebUpdateInstallationStatus | null {
  const parsed = webUpdateInstallationStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function canStartWebUpdate(state: WebUpdateInstallationState): boolean {
  return state === 'available' || state === 'failed' || state === 'rollback';
}

export function canManuallyCheckForUpdate(available: boolean, error: string | null): boolean {
  return !available && error === null;
}
