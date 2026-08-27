import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelRestartTransaction, consumeSupervisorTermination, createRestartAttestation, runRestartFallback, runRestartTransaction, verifyRestartAttestation, writeRestartTransaction } from './restart-transaction.js';

const temporaryDirectories = [];
const TARGET_REVISION = '2222222222222222222222222222222222222222';
const PREVIOUS_REVISION = '1111111111111111111111111111111111111111';

async function fixture() {
  const installRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-restart-')));
  temporaryDirectories.push(installRoot);
  const targetDirectory = path.join(installRoot, 'releases', `2.0.0-${TARGET_REVISION.slice(0, 12)}`);
  const previousDirectory = path.join(installRoot, 'archives', '1.0.0');
  const servicePath = path.join(installRoot, 'systemd', 'openchamber.service');
  const launcherPath = path.join(installRoot, 'bin', 'openchamber-managed');
  const statusPath = path.join(installRoot, 'update-status.json');
  const transactionPath = path.join(installRoot, 'restart-transaction.json');
  await Promise.all([
    fsp.mkdir(path.join(targetDirectory, 'dist'), { recursive: true }),
    fsp.mkdir(path.join(previousDirectory, 'dist'), { recursive: true }),
    fsp.mkdir(path.dirname(servicePath), { recursive: true }),
    fsp.mkdir(path.dirname(launcherPath), { recursive: true }),
  ]);
  await Promise.all([
    fsp.writeFile(path.join(targetDirectory, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '2.0.0' })),
    fsp.writeFile(path.join(targetDirectory, 'dist', 'build-revision.json'), JSON.stringify({ revision: TARGET_REVISION })),
    fsp.writeFile(path.join(previousDirectory, 'package.json'), JSON.stringify({ name: '@openchamber/web', version: '1.0.0' })),
    fsp.writeFile(path.join(previousDirectory, 'dist', 'build-revision.json'), JSON.stringify({ revision: PREVIOUS_REVISION })),
  ]);
  await fsp.symlink(targetDirectory, path.join(installRoot, 'current'));
  await fsp.writeFile(servicePath, 'migrated service', { mode: 0o600 });
  await fsp.writeFile(launcherPath, 'migrated launcher', { mode: 0o700 });
  const transaction = {
    schemaVersion: 3,
    manager: 'systemd',
    phase: 'target',
    installRoot,
    targetVersion: '2.0.0',
    targetRevision: TARGET_REVISION,
    targetDirectory,
    previousVersion: '1.0.0',
    previousRevision: PREVIOUS_REVISION,
    previousDirectory,
    healthUrl: 'http://127.0.0.1:7897/health',
    statusPath,
    transactionId: '12345678-1234-4123-8123-123456789abc',
    attestationSecret: 'a'.repeat(64),
    origin: { pid: 1234, startedAt: '2026-08-26T00:00:00.000Z' },
    systemd: {
      unit: 'openchamber.service',
      servicePath,
      serviceMode: 0o600,
      originalService: Buffer.from('original service').toString('base64'),
      launcherPath,
      launcherExisted: true,
      launcherMode: 0o700,
      originalLauncher: Buffer.from('original launcher').toString('base64'),
    },
  };
  const options = { systemdRoot: path.dirname(servicePath) };
  await writeRestartTransaction(transactionPath, transaction, options);
  return { installRoot, targetDirectory, previousDirectory, servicePath, launcherPath, statusPath, transactionPath, options, transaction };
}

async function supervisorFixture() {
  const value = await fixture();
  await fsp.rm(value.transactionPath, { force: true });
  const transaction = { ...value.transaction, manager: 'supervisor', systemd: null };
  await writeRestartTransaction(value.transactionPath, transaction);
  return { ...value, transaction };
}

function attestedFetch(value, { version, revision, pid = 2222, startedAt = '2026-08-26T00:01:00.000Z', healthy = true } = {}) {
  return vi.fn(async (_url, options = {}) => {
    const attestation = await createRestartAttestation({
      transactionPath: value.transactionPath,
      transactionId: options.headers['x-openchamber-transaction-id'],
      challenge: options.headers['x-openchamber-attestation-challenge'],
      currentVersion: version,
      currentRevision: revision,
      runtimePath: version === '2.0.0' ? value.targetDirectory : value.previousDirectory,
      pid,
      startedAt,
      healthy,
      options: value.options,
    });
    return { ok: true, json: async () => attestation };
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

describe('restart transaction helper', () => {
  it('commits installed state only after the selected target answers health', async () => {
    const value = await fixture();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    await runRestartTransaction(value.transactionPath, {
      spawnSyncImpl,
      fetchImpl: attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION }),
      ...value.options,
    });

    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.targetDirectory);
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'installed', currentVersion: '2.0.0' });
    expect(spawnSyncImpl).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'openchamber.service'], expect.any(Object));
    await expect(fsp.access(`${value.transactionPath}.processing`)).rejects.toThrow();
  });

  it('verifies a fresh authenticated attestation and rejects spoofed identity or replay', async () => {
    const value = await supervisorFixture();
    const challenge = 'b'.repeat(64);
    const attestation = await createRestartAttestation({
      transactionPath: value.transactionPath,
      transactionId: value.transaction.transactionId,
      challenge,
      currentVersion: '2.0.0',
      currentRevision: TARGET_REVISION,
      runtimePath: value.targetDirectory,
      pid: 2222,
      startedAt: '2026-08-26T00:01:00.000Z',
      healthy: true,
    });
    expect(attestation.attestationSecret).toBeUndefined();
    expect(verifyRestartAttestation(value.transaction, attestation, challenge, '2.0.0', TARGET_REVISION)).toMatchObject({ pid: 2222, healthy: true });
    expect(verifyRestartAttestation(value.transaction, { ...attestation, pid: 3333 }, challenge, '2.0.0', TARGET_REVISION)).toBeNull();
    expect(verifyRestartAttestation(value.transaction, { ...attestation, startedAt: '2026-08-26T00:02:00.000Z' }, challenge, '2.0.0', TARGET_REVISION)).toBeNull();
    expect(verifyRestartAttestation(value.transaction, { ...attestation, runningPath: value.previousDirectory }, challenge, '2.0.0', TARGET_REVISION)).toBeNull();
    expect(verifyRestartAttestation(value.transaction, { ...attestation, selectedPath: value.previousDirectory }, challenge, '2.0.0', TARGET_REVISION)).toBeNull();
    expect(verifyRestartAttestation(value.transaction, attestation, 'c'.repeat(64), '2.0.0', TARGET_REVISION)).toBeNull();
    await expect(createRestartAttestation({
      transactionPath: value.transactionPath,
      transactionId: '87654321-4321-4321-8321-cba987654321',
      challenge,
      currentVersion: '2.0.0',
      currentRevision: TARGET_REVISION,
      runtimePath: value.targetDirectory,
      pid: 2222,
      startedAt: attestation.startedAt,
      healthy: true,
    })).rejects.toThrow('ID does not match');
    await expect(createRestartAttestation({
      transactionPath: value.transactionPath,
      transactionId: value.transaction.transactionId,
      challenge,
      currentVersion: '2.0.0',
      currentRevision: PREVIOUS_REVISION,
      runtimePath: value.targetDirectory,
      pid: 2222,
      startedAt: attestation.startedAt,
      healthy: true,
    })).rejects.toThrow('release identity');
    await expect(createRestartAttestation({
      transactionPath: value.transactionPath,
      transactionId: value.transaction.transactionId,
      challenge,
      currentVersion: '2.0.0',
      currentRevision: TARGET_REVISION,
      runtimePath: value.previousDirectory,
      pid: 2222,
      startedAt: attestation.startedAt,
      healthy: true,
    })).rejects.toThrow('Runtime package path');
  });

  it('recovers prepared journals on either side of atomic selection', async () => {
    const beforeSelection = await fixture();
    await fsp.writeFile(beforeSelection.transactionPath, JSON.stringify({ ...beforeSelection.transaction, phase: 'prepared' }));
    await fsp.rm(path.join(beforeSelection.installRoot, 'current'));
    await fsp.symlink(beforeSelection.previousDirectory, path.join(beforeSelection.installRoot, 'current'));
    await expect(runRestartTransaction(beforeSelection.transactionPath, { spawnSyncImpl: vi.fn(() => ({ status: 0 })), ...beforeSelection.options })).resolves.toMatchObject({ state: 'failed' });
    expect(JSON.parse(await fsp.readFile(beforeSelection.statusPath, 'utf8')).state).toBe('failed');

    const afterSelection = await supervisorFixture();
    await fsp.writeFile(afterSelection.transactionPath, JSON.stringify({ ...afterSelection.transaction, phase: 'prepared' }));
    await expect(runRestartTransaction(afterSelection.transactionPath, {
      fetchImpl: attestedFetch(afterSelection, { version: '2.0.0', revision: TARGET_REVISION }),
      pollMs: 1,
    })).resolves.toMatchObject({ state: 'installed' });
  });

  it('restores exact selection, service, and launcher state when target health fails', async () => {
    const value = await fixture();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    await runRestartTransaction(value.transactionPath, {
      spawnSyncImpl,
      fetchImpl: attestedFetch(value, { version: '1.0.0', revision: PREVIOUS_REVISION }),
      targetTimeoutMs: 0,
      rollbackTimeoutMs: 100,
      ...value.options,
    });

    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.previousDirectory);
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe('original service');
    expect(await fsp.readFile(value.launcherPath, 'utf8')).toBe('original launcher');
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'rollback', currentVersion: '1.0.0' });
    expect(spawnSyncImpl).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'], expect.any(Object));
    expect(spawnSyncImpl).toHaveBeenLastCalledWith('systemctl', ['--user', 'restart', 'openchamber.service'], expect.any(Object));
  });

  it('persists failed when systemd rollback cannot be completed', async () => {
    const value = await fixture();
    let callCount = 0;
    const spawnSyncImpl = vi.fn(() => {
      callCount += 1;
      return callCount === 2
        ? { status: 1, stdout: '', stderr: 'daemon reload failed' }
        : { status: 0, stdout: '', stderr: '' };
    });

    await expect(runRestartTransaction(value.transactionPath, {
      spawnSyncImpl,
      fetchImpl: vi.fn(),
      targetTimeoutMs: 0,
      rollbackTimeoutMs: 0,
      ...value.options,
    })).rejects.toThrow('daemon reload failed');

    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({
      state: 'failed',
      currentVersion: '1.0.0',
      targetVersion: '2.0.0',
      previousVersion: '1.0.0',
    });
  });

  it('persists failed instead of rollback when the exact previous release cannot recover', async () => {
    const value = await fixture();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    await expect(runRestartTransaction(value.transactionPath, {
      spawnSyncImpl,
      fetchImpl: vi.fn(),
      targetTimeoutMs: 0,
      rollbackTimeoutMs: 0,
      ...value.options,
    })).rejects.toThrow('did not recover');
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'failed', currentVersion: '1.0.0' });
    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.previousDirectory);
  });

  it('commits a supervisor transaction after the old process exits and the exact target is healthy', async () => {
    const value = await supervisorFixture();
    const fetchImpl = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION });

    await expect(runRestartTransaction(value.transactionPath, { fetchImpl, pollMs: 1 })).resolves.toMatchObject({ state: 'installed' });
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'installed', currentVersion: '2.0.0' });
  });

  it('does not delete a newer fixed-path journal that appears during terminal cleanup', async () => {
    const value = await supervisorFixture();
    const newer = {
      ...value.transaction,
      transactionId: '87654321-4321-4321-8321-cba987654321',
      attestationSecret: 'd'.repeat(64),
    };
    await expect(runRestartTransaction(value.transactionPath, {
      fetchImpl: attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION }),
      pollMs: 1,
      beforeJournalCleanup: async () => writeRestartTransaction(value.transactionPath, newer),
    })).resolves.toMatchObject({ state: 'superseded' });
    expect(JSON.parse(await fsp.readFile(value.transactionPath, 'utf8')).transactionId).toBe(newer.transactionId);
  });

  it('cleans only bounded termination markers owned by the completed transaction', async () => {
    const value = await supervisorFixture();
    const ownRoot = path.join(value.installRoot, 'restart-termination', value.transaction.transactionId);
    const otherRoot = path.join(value.installRoot, 'restart-termination', '87654321-4321-4321-8321-cba987654321');
    await Promise.all([fsp.mkdir(ownRoot, { recursive: true }), fsp.mkdir(otherRoot, { recursive: true })]);
    await Promise.all([
      fsp.writeFile(path.join(ownRoot, 'b'.repeat(64)), 'used'),
      fsp.writeFile(path.join(otherRoot, 'c'.repeat(64)), 'other'),
    ]);
    await runRestartTransaction(value.transactionPath, {
      fetchImpl: attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION }),
      pollMs: 1,
    });
    await expect(fsp.access(ownRoot)).rejects.toThrow();
    await expect(fsp.access(path.join(otherRoot, 'c'.repeat(64)))).resolves.toBeUndefined();
  });

  it('retains the journal when termination marker cleanup exceeds its bound', async () => {
    const value = await supervisorFixture();
    const ownRoot = path.join(value.installRoot, 'restart-termination', value.transaction.transactionId);
    await fsp.mkdir(ownRoot, { recursive: true });
    await Promise.all(Array.from({ length: 257 }, (_, index) => fsp.writeFile(path.join(ownRoot, index.toString(16).padStart(64, '0')), 'used')));
    await expect(runRestartTransaction(value.transactionPath, {
      fetchImpl: attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION }),
      pollMs: 1,
    })).rejects.toThrow('entry limit');
    expect(JSON.parse(await fsp.readFile(value.transactionPath, 'utf8')).phase).toBe('failed');
  });

  it('restores exact systemd files before cancelling and retains evidence if reload fails', async () => {
    const value = await fixture();
    await fsp.rm(path.join(value.installRoot, 'current'));
    await fsp.symlink(value.previousDirectory, path.join(value.installRoot, 'current'));
    const reloadFailure = vi.fn(() => ({ status: 1, stdout: '', stderr: 'reload failed' }));
    await expect(cancelRestartTransaction(value.transactionPath, value.transaction.transactionId, {
      ...value.options,
      spawnSyncImpl: reloadFailure,
    })).rejects.toThrow('reload failed');
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe('original service');
    expect(await fsp.readFile(value.launcherPath, 'utf8')).toBe('original launcher');
    expect(JSON.parse(await fsp.readFile(value.transactionPath, 'utf8')).transactionId).toBe(value.transaction.transactionId);
  });

  it('rolls a crash-looping supervisor target back and verifies the previous revision', async () => {
    const value = await supervisorFixture();
    const fetchImpl = attestedFetch(value, { version: '1.0.0', revision: PREVIOUS_REVISION });

    await expect(runRestartTransaction(value.transactionPath, {
      fetchImpl,
      targetTimeoutMs: 0,
      supervisorConfirmationTimeoutMs: 0,
      rollbackTimeoutMs: 100,
      pollMs: 1,
    })).resolves.toMatchObject({ state: 'rollback' });
    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.previousDirectory);
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'rollback', currentVersion: '1.0.0' });
  });

  it('accepts an authenticated already-running previous release on interrupted rollback rerun', async () => {
    const value = await supervisorFixture();
    await fsp.rm(path.join(value.installRoot, 'current'));
    await fsp.symlink(value.previousDirectory, path.join(value.installRoot, 'current'));
    await fsp.writeFile(value.transactionPath, JSON.stringify({ ...value.transaction, phase: 'rollback' }));
    const previousFetch = attestedFetch(value, { version: '1.0.0', revision: PREVIOUS_REVISION, pid: 3333 });
    const fetchImpl = vi.fn((url, options) => {
      if (options?.method === 'POST') throw new Error('must not terminate an already recovered previous release');
      return previousFetch(url, options);
    });
    await expect(runRestartFallback(value.transactionPath, {
      expectedTransactionId: value.transaction.transactionId,
      fetchImpl,
      pollMs: 1,
      supervisorConfirmationTimeoutMs: 100,
    })).resolves.toMatchObject({ state: 'rollback' });
    expect(fetchImpl.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
  });

  it('asks an unhealthy running target to terminate itself only after durable rollback intent', async () => {
    const value = await supervisorFixture();
    let rollbackRequested = false;
    const targetFetch = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION, healthy: false });
    const previousFetch = attestedFetch(value, { version: '1.0.0', revision: PREVIOUS_REVISION });
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') {
        const journal = JSON.parse(await fsp.readFile(value.transactionPath, 'utf8'));
        const status = JSON.parse(await fsp.readFile(value.statusPath, 'utf8'));
        expect(journal.phase).toBe('rollback');
        expect(status.state).toBe('restarting');
        expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.previousDirectory);
        rollbackRequested = true;
        return { ok: true, status: 202 };
      }
      if (rollbackRequested) return previousFetch(url, options);
      const selected = await fsp.realpath(path.join(value.installRoot, 'current'));
      if (selected !== value.targetDirectory) return { ok: false, json: async () => ({}) };
      return targetFetch(url, options);
    });

    await expect(runRestartTransaction(value.transactionPath, {
      fetchImpl,
      targetTimeoutMs: 5,
      rollbackTimeoutMs: 100,
      pollMs: 1,
    })).resolves.toMatchObject({ state: 'rollback' });
    expect(rollbackRequested).toBe(true);
  });

  it('consumes termination authorization once for the exact target process identity', async () => {
    const value = await supervisorFixture();
    await fsp.writeFile(value.transactionPath, JSON.stringify({ ...value.transaction, phase: 'rollback' }));
    await fsp.rm(path.join(value.installRoot, 'current'));
    await fsp.symlink(value.previousDirectory, path.join(value.installRoot, 'current'));
    const pid = 2222;
    const startedAt = '2026-08-26T00:01:00.000Z';
    const nonce = 'b'.repeat(64);
    const authorization = crypto.createHmac('sha256', Buffer.from(value.transaction.attestationSecret, 'hex'))
      .update(['terminate', value.transaction.transactionId, String(pid), startedAt, nonce].join('\0')).digest('hex');
    const request = {
      transactionPath: value.transactionPath,
      transactionId: value.transaction.transactionId,
      pid,
      startedAt,
      nonce,
      authorization,
      currentVersion: '2.0.0',
      currentRevision: TARGET_REVISION,
      actualPid: pid,
      actualStartedAt: startedAt,
    };
    for (const invalid of [
      { ...request, transactionId: '87654321-4321-4321-8321-cba987654321' },
      { ...request, currentVersion: '2.0.1' },
      { ...request, currentRevision: PREVIOUS_REVISION },
      { ...request, actualPid: 9999 },
      { ...request, actualStartedAt: '2026-08-26T00:02:00.000Z' },
      { ...request, authorization: 'f'.repeat(64) },
    ]) await expect(consumeSupervisorTermination(invalid)).resolves.toBe(false);
    await expect(consumeSupervisorTermination(request)).resolves.toBe(true);
    await expect(consumeSupervisorTermination(request)).resolves.toBe(false);
    await expect(consumeSupervisorTermination({ ...request, actualStartedAt: 'wrong' })).resolves.toBe(false);
    const nextStartedAt = '2026-08-26T00:02:00.000Z';
    const nextNonce = 'c'.repeat(64);
    const nextAuthorization = crypto.createHmac('sha256', Buffer.from(value.transaction.attestationSecret, 'hex'))
      .update(['terminate', value.transaction.transactionId, String(pid), nextStartedAt, nextNonce].join('\0')).digest('hex');
    await expect(consumeSupervisorTermination({
      ...request,
      startedAt: nextStartedAt,
      nonce: nextNonce,
      authorization: nextAuthorization,
      actualStartedAt: nextStartedAt,
    })).resolves.toBe(true);
  });

  it('allows one helper lease owner and recovers a stale lease after helper failure', async () => {
    const value = await supervisorFixture();
    let resolveTarget;
    const targetFetch = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION });
    const fetchImpl = vi.fn((url, options) => new Promise((resolve) => { resolveTarget = () => targetFetch(url, options).then(resolve); }));
    const primary = runRestartTransaction(value.transactionPath, { fetchImpl, targetTimeoutMs: 5_000, pollMs: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await expect(runRestartTransaction(value.transactionPath, { fetchImpl })).resolves.toEqual({ owned: false });
    resolveTarget();
    await expect(primary).resolves.toMatchObject({ state: 'installed' });

    const recovered = await supervisorFixture();
    await fsp.mkdir(`${recovered.transactionPath}.lease`);
    const old = new Date(Date.now() - 30_000);
    await fsp.utimes(`${recovered.transactionPath}.lease`, old, old);
    const recoveredFetch = attestedFetch(recovered, { version: '2.0.0', revision: TARGET_REVISION });
    await expect(runRestartTransaction(recovered.transactionPath, { fetchImpl: recoveredFetch, leaseStaleMs: 2_000, pollMs: 1 })).resolves.toMatchObject({ state: 'installed' });
  });

  it('fences a paused primary helper after fallback ownership changes', async () => {
    const value = await supervisorFixture();
    let resolveTarget;
    const targetFetch = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION });
    const fetchImpl = vi.fn((url, options) => new Promise((resolve) => { resolveTarget = () => targetFetch(url, options).then(resolve); }));
    const primary = runRestartTransaction(value.transactionPath, { fetchImpl, targetTimeoutMs: 5_000, pollMs: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await fsp.writeFile(`${value.transactionPath}.owner`, `${'f'.repeat(64)}\n`);
    resolveTarget();
    await expect(primary).rejects.toThrow('lost ownership');
    await expect(fsp.access(value.statusPath)).rejects.toThrow();

    const recoveryFetch = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION });
    await expect(runRestartTransaction(value.transactionPath, { fetchImpl: recoveryFetch, pollMs: 1 })).resolves.toMatchObject({ state: 'installed' });
  });

  it('keeps a fallback alive until a busy primary lease becomes recoverable', async () => {
    const value = await supervisorFixture();
    await fsp.mkdir(`${value.transactionPath}.lease`);
    const delayImpl = vi.fn(async () => {
      await fsp.rm(`${value.transactionPath}.lease`, { recursive: true, force: true });
    });
    const fetchImpl = attestedFetch(value, { version: '2.0.0', revision: TARGET_REVISION });
    await expect(runRestartFallback(value.transactionPath, {
      fetchImpl,
      delayImpl,
      recoveryWindowMs: 1_000,
      recoveryPollMs: 1,
      pollMs: 1,
    })).resolves.toMatchObject({ state: 'installed' });
    expect(delayImpl).toHaveBeenCalled();
  });

  it('exits an old delayed fallback before leasing or mutating a newer fixed-path transaction', async () => {
    const value = await supervisorFixture();
    const oldTransactionId = value.transaction.transactionId;
    const newer = {
      ...value.transaction,
      transactionId: '87654321-4321-4321-8321-cba987654321',
      attestationSecret: 'd'.repeat(64),
    };
    await writeRestartTransaction(value.transactionPath, newer);
    await expect(runRestartFallback(value.transactionPath, {
      expectedTransactionId: oldTransactionId,
      recoveryWindowMs: 100,
    })).resolves.toEqual({ owned: false, state: 'superseded' });
    await expect(fsp.access(`${value.transactionPath}.lease`)).rejects.toThrow();
    expect(JSON.parse(await fsp.readFile(value.transactionPath, 'utf8')).transactionId).toBe(newer.transactionId);
    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.targetDirectory);
  });

  it('bounds hung system commands and persists failed after rollback cannot run', async () => {
    const value = await fixture();
    const timeoutError = Object.assign(new Error('systemctl timed out'), { code: 'ETIMEDOUT' });
    const spawnSyncImpl = vi.fn(() => ({ status: null, stdout: '', stderr: '', error: timeoutError }));
    await expect(runRestartTransaction(value.transactionPath, { spawnSyncImpl, ...value.options })).rejects.toThrow('systemctl timed out');
    expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.previousDirectory);
    expect(JSON.parse(await fsp.readFile(value.statusPath, 'utf8'))).toMatchObject({ state: 'failed' });
    expect(spawnSyncImpl.mock.calls.every((call) => call[2].timeout === 10_000)).toBe(true);
  });

  it('rejects tampered transaction fields before writing or mutating unrelated paths', async () => {
    const value = await fixture();
    const originalService = await fsp.readFile(value.servicePath, 'utf8');
    const cases = [
      { ...value.transaction, unexpected: true },
      { ...value.transaction, statusPath: path.join(value.installRoot, '..', 'outside-status.json') },
      { ...value.transaction, targetRevision: 'invalid' },
      { ...value.transaction, transactionId: 'not-a-uuid' },
      { ...value.transaction, attestationSecret: 'short' },
      { ...value.transaction, systemd: { ...value.transaction.systemd, unit: 'openchamber.service;rm' } },
      { ...value.transaction, systemd: { ...value.transaction.systemd, servicePath: path.join(value.installRoot, '..', 'outside.service') } },
      { ...value.transaction, systemd: { ...value.transaction.systemd, serviceMode: 0o1000 } },
      { ...value.transaction, systemd: { ...value.transaction.systemd, originalService: 'not base64' } },
      { ...value.transaction, systemd: { ...value.transaction.systemd, launcherExisted: false } },
    ];
    for (const tampered of cases) {
      await fsp.rm(value.transactionPath, { force: true });
      await expect(writeRestartTransaction(value.transactionPath, tampered, value.options)).rejects.toThrow();
      await expect(fsp.access(value.transactionPath)).rejects.toThrow();
      expect(await fsp.realpath(path.join(value.installRoot, 'current'))).toBe(value.targetDirectory);
      expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(originalService);
    }
  });

  it('validates a pre-migration systemd journal when the managed launcher did not previously exist', async () => {
    const value = await fixture();
    await fsp.rm(value.launcherPath);
    await fsp.rm(value.transactionPath);
    const prepared = {
      ...value.transaction,
      phase: 'prepared',
      systemd: {
        ...value.transaction.systemd,
        launcherExisted: false,
        originalLauncher: null,
      },
    };
    await expect(writeRestartTransaction(value.transactionPath, prepared, value.options)).resolves.toBeUndefined();
    expect(JSON.parse(await fsp.readFile(value.transactionPath, 'utf8'))).toMatchObject({ phase: 'prepared', systemd: { launcherExisted: false } });
  });
});
