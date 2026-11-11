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

export type PtyWaitingJob = {
  id: string;
  createdAt: number;
  description: string | null;
};

export type PtyWaitingState = {
  count: number;
  oldestCreatedAt: number | null;
  description: string | null;
  /** Every valid PTY job, oldest first. */
  jobs: readonly PtyWaitingJob[];
};

const EMPTY_PTY_WAITING_STATE: PtyWaitingState = {
  count: 0,
  oldestCreatedAt: null,
  description: null,
  jobs: [],
};

export function getPtyWaitingState(session: Session | null | undefined): PtyWaitingState {
  if (!session || !('metadata' in session)) return EMPTY_PTY_WAITING_STATE;

  const metadata = ptyJobsMetadataSchema.safeParse(session.metadata);
  if (!metadata.success) return EMPTY_PTY_WAITING_STATE;

  const jobs: PtyWaitingJob[] = [];
  for (const candidate of metadata.data.openchamber.backgroundJobs.jobs) {
    const job = ptyJobSchema.safeParse(candidate);
    if (!job.success) continue;
    jobs.push({
      id: job.data.id,
      createdAt: job.data.createdAt,
      description: job.data.description?.trim() || null,
    });
  }

  if (jobs.length === 0) return EMPTY_PTY_WAITING_STATE;
  jobs.sort((left, right) => left.createdAt - right.createdAt);
  return {
    count: jobs.length,
    oldestCreatedAt: jobs[0].createdAt,
    description: jobs.length === 1 ? jobs[0].description : null,
    jobs,
  };
}

/** Compares the fields that drive rendering, so memoized rows can skip the metadata object. */
export function arePtyWaitingStatesEqual(previous: PtyWaitingState, next: PtyWaitingState): boolean {
  if (previous === next) return true;
  if (previous.count !== next.count || previous.oldestCreatedAt !== next.oldestCreatedAt || previous.description !== next.description) {
    return false;
  }
  return previous.jobs.every((job, index) => {
    const other = next.jobs[index];
    return other !== undefined && job.id === other.id && job.createdAt === other.createdAt && job.description === other.description;
  });
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
