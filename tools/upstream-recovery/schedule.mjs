#!/usr/bin/env node
// Install only after deployment approval. Credentials remain inside this process.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPassword } from './bee2.mjs';

export function taskDefinition(configFile, model, enabled) {
  if (!isAbsolute(configFile) || !model?.providerID || !model?.id) throw new Error('Absolute config path and model required');
  const script = fileURLToPath(new URL('./reconcile.mjs', import.meta.url));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const task = {
    id: 'j2k-upstream-recovery-monitor',
    name: 'J2K upstream recovery monitor',
    enabled,
    schedule: { kind: 'cron', cron: '*/15 * * * *', timezone: 'UTC' },
    execution: {
      providerID: model.providerID, modelID: model.id,
      goalEnabled: false,
      prompt: `Run this one bounded command once, report its JSON outcome, then stop: ${quote(process.execPath)} ${quote(script)} tick ${quote(configFile)}. The deterministic reconciler owns retry and worker dispatch. Do not run git, edit files, merge, publish, or start another monitor yourself.`,
    },
    runInWorktree: false,
  };
  if (model.variant) task.execution.variant = model.variant;
  return task;
}

async function main() {
  const [mode, projectID, configFile] = process.argv.slice(2);
  if (!['preview', 'enable', 'disable', 'status'].includes(mode) || !projectID || !configFile) {
    throw new Error('Usage: node schedule.mjs preview|enable|disable|status <projectID> <absolute-config.json>');
  }
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const task = taskDefinition(configFile, config.model, mode === 'enable');
  if (mode === 'preview') { console.log(JSON.stringify({ task }, null, 2)); return; }
  const password = await readPassword('openchamber_ui_password');
  const login = await fetch('http://127.0.0.1:3002/auth/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }), signal: AbortSignal.timeout(15_000),
  });
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (!login.ok || !cookie) throw new Error(`OpenChamber login HTTP ${login.status}`);
  const url = `http://127.0.0.1:3002/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`;
  if (mode !== 'status') {
    const response = await fetch(url, {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Scheduler PUT HTTP ${response.status}`);
  }
  const response = await fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Scheduler GET HTTP ${response.status}`);
  const result = await response.json();
  const installed = result.tasks.find((entry) => entry.id === task.id);
  if (!installed) throw new Error('Recovery task is not installed');
  console.log(JSON.stringify(installed, null, 2));
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
