// Pushover pushes for OPM items that demand the owner. The dashboard already
// surfaces these, but a red pill helps only while the page is open; a
// protected-path authorisation request otherwise sits unnoticed. Credentials
// come from the macOS login keychain (the same entries Uptime Kuma
// provisioning stored); missing credentials disable pushing without touching
// the dashboard or the poll loop.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const readKeychainSecret = async (service) => {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w']);
  const secret = stdout.trim();
  if (!secret) throw new Error(`keychain item ${service} is empty`);
  return secret;
};

export const createPushoverNotifier = ({
  readSecret = readKeychainSecret,
  fetchImpl = fetch,
  stateFile = path.join(os.homedir(), '.local', 'state', 'openchamber-opm-status-notified.json'),
  userKeyService = 'Uptime Kuma Pushover User Key',
  apiTokenService = 'Uptime Kuma Pushover API Token',
  log = (message) => console.warn(`[opm-status] ${message}`),
} = {}) => {
  let credentials = null;
  let credentialsFailed = false;

  const loadCredentials = async () => {
    if (credentials || credentialsFailed) return credentials;
    try {
      credentials = {
        user: await readSecret(userKeyService),
        token: await readSecret(apiTokenService),
      };
    } catch (error) {
      credentialsFailed = true;
      log(`pushover disabled: ${error?.message || error}`);
    }
    return credentials;
  };

  // Dedupe keys live on disk so restarts and parallel server instances do not
  // re-push what an earlier process already delivered.
  const readNotified = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return Array.isArray(parsed) ? new Set(parsed) : new Set();
    } catch {
      return new Set();
    }
  };
  const writeNotified = (keys) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify([...keys].slice(-100)));
    } catch (error) {
      log(`pushover state write failed: ${error?.message || error}`);
    }
  };

  const notify = async (snapshot) => {
    if (!snapshot || snapshot.available !== true) return;
    const demands = [
      ...snapshot.groups.needsYou.map((row) => ({
        key: `${row.project}#${row.ref}:${row.command || row.reason || ''}`,
        title: `OPM needs you: ${row.projectName || row.project} #${row.ref}`,
        message: row.command
          ? `${row.title}\n\nPost on issue #${row.ref}:\n${row.command}`
          : `${row.title}\n\n${row.reason || ''}`,
        url: row.url,
      })),
      ...(snapshot.supervisor?.attention || [])
        .filter((item) => item.kind === 'stalled')
        .map((item) => ({
          key: `stalled#${item.ref}:${item.detail || ''}`,
          title: `OPM stalled: #${item.ref}`,
          message: item.detail || 'A work item stalled despite a re-wake.',
          url: null,
        })),
    ];
    if (demands.length === 0) return;
    const loaded = await loadCredentials();
    if (!loaded) return;
    const notified = readNotified();
    let changed = false;
    for (const demand of demands) {
      if (notified.has(demand.key)) continue;
      const body = new URLSearchParams({
        token: loaded.token,
        user: loaded.user,
        title: demand.title,
        message: demand.message.slice(0, 1000),
        priority: '1',
        ...(demand.url ? { url: demand.url } : {}),
      });
      try {
        const response = await fetchImpl('https://api.pushover.net/1/messages.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`pushover returned ${response.status}`);
        notified.add(demand.key);
        changed = true;
      } catch (error) {
        // Failed sends retry on the next poll: the key is only recorded on
        // success, and duplicate suppression is the recorded key itself.
        log(`pushover send failed: ${error?.message || error}`);
      }
    }
    if (changed) writeNotified(notified);
  };

  return { notify };
};
