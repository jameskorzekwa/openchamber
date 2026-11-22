import { z } from 'zod';

export const routingUpdatedSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
  jevAvailable: z.boolean().default(true),
  tokenPresent: z.boolean(),
  jevSource: z.enum(['typesafe', 'zen-free']),
});

export const routingDecisionSchema = z.object({
  sessionId: z.string().min(1),
  at: z.number(),
  category: z.string().nullable(),
  confidence: z.number(),
  reason: z.enum(['routed', 'low-confidence', 'unknown-category', 'error', 'not-ready']),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  variant: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  error: z.string().optional(),
});

export const routingPermissionHeldSchema = z.object({
  permissionId: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().nullable().default(null),
  score: z.number(),
  kind: z.string().nullable(),
});

export const routingSafetySkippedSchema = z.object({
  permissionId: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().nullable().default(null),
  error: z.string(),
});

export type RoutingUpdatedEvent = { type: 'routing-updated' } & z.infer<typeof routingUpdatedSchema>;
export type RoutingDecisionEvent = { type: 'routing-decision'; decision: z.infer<typeof routingDecisionSchema> };
export type RoutingPermissionHeldEvent = { type: 'routing-permission-held' } & z.infer<typeof routingPermissionHeldSchema>;
export type RoutingSafetySkippedEvent = { type: 'routing-safety-skipped' } & z.infer<typeof routingSafetySkippedSchema>;
