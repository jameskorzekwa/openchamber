import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPushoverNotifier } from './pushover-notifier.js';

const SHA = 'a'.repeat(40);
const needsYouRow = (overrides = {}) => ({
  project: 'openchamber',
  projectName: 'OpenChamber',
  ref: '7',
  title: 'Port OPM status',
  command: `/agent authorize ${SHA}`,
  reason: `needs owner authorisation; comment "/agent authorize ${SHA}"`,
  url: 'https://github.com/o/r/issues/7',
  ...overrides,
});

const snapshot = ({ needsYou = [], attention = [] } = {}) => ({
  available: true,
  groups: { needsYou, blocked: [], active: [], waiting: [], queued: [] },
  supervisor: { attention },
});

const okFetch = () => vi.fn().mockResolvedValue({ ok: true, status: 200 });
const goodSecrets = vi.fn(async (service) => (service.includes('User Key') ? 'user-key' : 'api-token'));

describe('OPM pushover notifier', () => {
  let stateFile;
  let log;

  beforeEach(() => {
    stateFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'opm-notify-')), 'notified.json');
    log = vi.fn();
    goodSecrets.mockClear();
  });

  it('pushes each new needs-owner demand once with the exact command, form-encoded at priority 1', async () => {
    const fetchImpl = okFetch();
    const notifier = createPushoverNotifier({ readSecret: goodSecrets, fetchImpl, stateFile, log });

    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));
    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(options.body);
    expect(body.get('token')).toBe('api-token');
    expect(body.get('user')).toBe('user-key');
    expect(body.get('title')).toBe('OPM needs you: OpenChamber #7');
    expect(body.get('message')).toContain(`/agent authorize ${SHA}`);
    expect(body.get('priority')).toBe('1');
    expect(body.get('url')).toBe('https://github.com/o/r/issues/7');
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toContain(`openchamber#7:/agent authorize ${SHA}`);
  });

  it('pushes new stalled attention entries and ignores other attention kinds', async () => {
    const fetchImpl = okFetch();
    const notifier = createPushoverNotifier({ readSecret: goodSecrets, fetchImpl, stateFile, log });

    await notifier.notify(snapshot({
      attention: [
        { kind: 'stalled', ref: '9', detail: 'no progress after re-wake' },
        { kind: 'unpropagated', ref: '10', detail: 'other' },
      ],
    }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(fetchImpl.mock.calls[0][1].body);
    expect(body.get('title')).toBe('OPM stalled: #9');
    expect(body.get('message')).toBe('no progress after re-wake');
  });

  it('disables pushing with a single warning when keychain credentials are missing, without throwing', async () => {
    const fetchImpl = okFetch();
    const readSecret = vi.fn().mockRejectedValue(new Error('The specified item could not be found'));
    const notifier = createPushoverNotifier({ readSecret, fetchImpl, stateFile, log });

    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));
    await notifier.notify(snapshot({ needsYou: [needsYouRow({ ref: '8' })] }));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('pushover disabled');
  });

  it('deduplicates across notifier instances through the shared state file', async () => {
    const first = okFetch();
    await createPushoverNotifier({ readSecret: goodSecrets, fetchImpl: first, stateFile, log })
      .notify(snapshot({ needsYou: [needsYouRow()] }));
    expect(first).toHaveBeenCalledTimes(1);

    const second = okFetch();
    await createPushoverNotifier({ readSecret: goodSecrets, fetchImpl: second, stateFile, log })
      .notify(snapshot({ needsYou: [needsYouRow()] }));
    expect(second).not.toHaveBeenCalled();
  });

  it('retries failed sends on the next poll because only successful sends are recorded', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true, status: 200 });
    const notifier = createPushoverNotifier({ readSecret: goodSecrets, fetchImpl, stateFile, log });

    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));
    expect(() => readFileSync(stateFile, 'utf8')).toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pushover send failed'));

    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toHaveLength(1);
  });

  it('keeps only the most recent 100 dedupe keys', async () => {
    writeFileSync(stateFile, JSON.stringify(Array.from({ length: 100 }, (_, i) => `old#${i}:`)));
    const notifier = createPushoverNotifier({ readSecret: goodSecrets, fetchImpl: okFetch(), stateFile, log });

    await notifier.notify(snapshot({ needsYou: [needsYouRow()] }));

    const stored = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(stored).toHaveLength(100);
    expect(stored.at(-1)).toBe(`openchamber#7:/agent authorize ${SHA}`);
    expect(stored).not.toContain('old#0:');
  });

  it('does nothing for unavailable snapshots or when nothing demands the owner', async () => {
    const fetchImpl = okFetch();
    const readSecret = vi.fn(goodSecrets);
    const notifier = createPushoverNotifier({ readSecret, fetchImpl, stateFile, log });

    await notifier.notify({ available: false, error: 'down' });
    await notifier.notify(snapshot());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
  });
});
