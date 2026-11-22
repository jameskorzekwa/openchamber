import { z } from 'zod';
import { isGuestApproved, requestedGuestCapabilities } from '@openchamber/sdk';
import type { GuestWaitParam, WaitContribution } from '@openchamber/sdk';
import type { GuestRecord } from '../guests/contracts.js';
import type { WaitArgs } from './wake-message.js';
import { BUILT_IN_EXTENSION, isBuiltIn } from './builtin-waits.js';

export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const argsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const waitSchema = z.object({
  id: z.string().regex(/^wait_[A-Za-z0-9-]{8,64}$/),
  sessionID: sessionIdSchema,
  directory: z.string().min(1).nullable(),
  guestId: z.string().min(1).nullable(),
  extensionName: z.string().min(1).nullable().catch(null),
  type: z.string().min(1),
  title: z.string().min(1),
  label: z.string().min(1).nullable(),
  args: argsSchema,
  state: z.unknown(),
  startedAt: z.number().finite().nonnegative(),
  nextCheckAt: z.number().finite().nonnegative(),
  failingSince: z.number().finite().nonnegative().nullable().catch(null),
  wake: z.object({
    outcome: z.enum(['fired', 'ended']),
    summary: z.string().min(1),
    messageID: z.string().nullable(),
  }).nullable(),
});
export const storedFileSchema = z.object({ revision: z.number().int().nonnegative().optional(), waits: z.array(z.unknown()) });
export const errorCodeSchema = z.object({ code: z.string() });
export const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
export const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

export type Wait = Omit<z.output<typeof waitSchema>, 'args'> & { args: WaitArgs };
export type WaitProvider = GuestRecord & { waits: WaitContribution[] };

export interface PublicWait {
  waitId: string;
  sessionID: string;
  directory: string | null;
  source: string;
  extension: string;
  title: string;
  label: string | null;
  args: WaitArgs;
  startedAt: number;
  status: 'waking' | 'waiting';
}

export interface PublicWaitSource {
  source: string;
  extension: string;
  title: string;
  description: string;
  params: Record<string, GuestWaitParam>;
}

export interface ExtensionWaitsSnapshot {
  revision: number;
  waits: PublicWait[];
}

export const parse = <S extends z.ZodType>(schema: S, value: Parameters<S['safeParse']>[0]): z.output<S> | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const parseJson = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
};

export const isWaitProvider = (guest: GuestRecord | null | undefined): guest is WaitProvider => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return !!guest
    && guest.enabled !== false
    && Array.isArray(guest.waits)
    && guest.waits.length > 0
    && granted.includes('service')
    && granted.includes('wake')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

export const sourceOf = (wait: Wait) => (isBuiltIn(wait) ? wait.type : `${wait.guestId}/${wait.type}`);

export const toPublicWait = (wait: Wait): PublicWait => ({
  waitId: wait.id,
  sessionID: wait.sessionID,
  directory: wait.directory,
  source: sourceOf(wait),
  extension: wait.extensionName ?? wait.guestId ?? BUILT_IN_EXTENSION,
  title: wait.title,
  label: wait.label,
  args: { ...wait.args },
  startedAt: wait.startedAt,
  status: wait.wake ? 'waking' : 'waiting',
});

export const toPublicSource = (guest: WaitProvider, wait: WaitContribution): PublicWaitSource => ({
  source: `${guest.id}/${wait.id}`,
  extension: guest.name || guest.id,
  title: wait.title,
  description: wait.description,
  params: { ...(wait.params ?? {}) },
});
