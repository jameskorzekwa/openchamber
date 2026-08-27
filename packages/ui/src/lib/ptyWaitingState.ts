import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

const ptyJobSchema = z.object({
  id: z.string().trim().min(1),
  kind: z.literal('pty'),
  createdAt: z.number().finite().positive(),
  description: z.string().optional(),
});

const ptyJobsMetadataSchema = z.object({
  openchamber: z.object({
    backgroundJobs: z.object({
      jobs: z.array(z.json()),
    }),
  }),
});

export type PtyWaitingState = {
  count: number;
  oldestCreatedAt: number | null;
  description: string | null;
};

const EMPTY_PTY_WAITING_STATE: PtyWaitingState = {
  count: 0,
  oldestCreatedAt: null,
  description: null,
};

export function getPtyWaitingState(session: Session | null | undefined): PtyWaitingState {
  if (!session || !('metadata' in session)) return EMPTY_PTY_WAITING_STATE;

  const metadata = ptyJobsMetadataSchema.safeParse(session.metadata);
  if (!metadata.success) return EMPTY_PTY_WAITING_STATE;

  let count = 0;
  let oldestCreatedAt = Number.POSITIVE_INFINITY;
  let description: string | null = null;

  for (const candidate of metadata.data.openchamber.backgroundJobs.jobs) {
    const job = ptyJobSchema.safeParse(candidate);
    if (!job.success) continue;

    count += 1;
    oldestCreatedAt = Math.min(oldestCreatedAt, job.data.createdAt);
    if (count === 1) {
      description = job.data.description?.trim() || null;
    } else {
      description = null;
    }
  }

  if (count === 0) return EMPTY_PTY_WAITING_STATE;
  return { count, oldestCreatedAt, description };
}

export function formatPtyWaitingElapsed(elapsedSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
