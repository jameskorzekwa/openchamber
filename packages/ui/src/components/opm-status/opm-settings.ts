import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const values = z.record(z.string(), z.json());
const project = z.object({ slug: z.string() }).catchall(z.json());
const configuration = z.object({ projects: z.array(project).default([]) }).catchall(z.json());
const settingsSchema = z.object({
  revision: z.string(),
  config: configuration,
  effective: configuration,
  defaults: values,
  fieldKinds: z.record(z.string(), z.record(z.string(), z.enum(['json', 'number', 'boolean', 'string']))),
  keys: z.object({
    global: z.array(z.string()), project: z.array(z.string()),
    providerConfig: z.array(z.string()), policy: z.array(z.string()), overrides: z.array(z.string()),
  }).catchall(z.array(z.string())),
  restartRequiredKeys: z.array(z.string()),
  restartRequired: z.array(z.string()),
  projects: z.array(z.object({
    slug: z.string(),
    inherited: z.record(z.string(), z.object({ source: z.enum(['global', 'project', 'providerConfig']), value: z.json() })),
  })),
});
const resultSchema = z.object({
  applied: z.boolean(), saved: z.boolean().optional(), revision: z.string().optional(),
  confirmationRequired: z.array(z.string()).optional(), confirmation: z.string().optional(),
  restartRequired: z.array(z.string()).optional(), message: z.string().optional(),
});
export type OpmSettings = z.infer<typeof settingsSchema>;
export type OpmConfiguration = z.infer<typeof configuration>;
export type SettingValue = z.infer<ReturnType<typeof z.json>>;
export type SettingsResult = z.infer<typeof resultSchema>;

export async function fetchOpmSettings(signal?: AbortSignal): Promise<OpmSettings> {
  const response = await runtimeFetch('/api/opm/settings', { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(body).error);
  return settingsSchema.parse(body);
}

export async function saveOpmSettings(config: OpmConfiguration, revision: string, confirmation?: string): Promise<SettingsResult> {
  const response = await runtimeFetch('/api/opm/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config, revision, confirmation }),
  });
  const body = await response.json();
  const result = resultSchema.safeParse(body);
  if (result.success) return result.data;
  throw new Error(z.object({ error: z.string() }).parse(body).error);
}

export const settingObject = (value: SettingValue | undefined) => values.parse(value ?? {});
