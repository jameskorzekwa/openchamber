import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');
const checkForUpdates = vi.fn();
const spawnSync = vi.fn();
const spawn = vi.fn(() => ({ pid: 4321, unref: vi.fn() }));
const rollbackService = vi.fn();
const applyService = vi.fn();
const rollbackState = { servicePath: '/tmp/openchamber.service', originalService: 'c2VydmljZQ==', serviceMode: 0o600 };
const migrateSystemdServiceToManagedLauncher = vi.fn(() => ({ apply: applyService, rollback: rollbackService, rollbackState }));
const writeRestartTransaction = vi.fn(async () => {});
const activateRestartTransaction = vi.fn(async () => {});
const cancelRestartTransaction = vi.fn(async () => true);

function createInstaller() {
  let status = {
    schemaVersion: 1,
    state: 'installed',
    currentVersion: '1.0.0',
    targetVersion: null,
    previousVersion: null,
    error: null,
    updatedAt: '2026-08-26T00:00:00.000Z',
  };
  return {
    getStatus: vi.fn(() => status),
    isInstalling: vi.fn(() => status.state === 'downloading' || status.state === 'installing' || status.state === 'restarting'),
    noteAvailable: vi.fn((info) => {
      status = { ...status, state: 'available', targetVersion: info.version };
    }),
    checkForUpdate: vi.fn(async () => {
      const info = await checkForUpdates();
      status = { ...status, state: 'available', targetVersion: info.version };
      return { ...info, channel: 'j2k', channelRepository: 'jameskorzekwa/openchamber' };
    }),
    beginInstall: vi.fn(async ({ targetVersion, prepareRestart, handoffRestart, cancelRestart }) => {
      const context = {
        installRoot: '/tmp/openchamber-install',
        statusPath: '/tmp/openchamber-install/update-status.json',
        targetVersion,
        targetRevision: '2'.repeat(40),
        targetDirectory: '/tmp/openchamber-install/releases/2.0.0',
        previousVersion: '1.0.0',
        previousRevision: '1'.repeat(40),
        previousDirectory: '/tmp/openchamber-install/archives/1.0.0',
      };
      const restartPreparation = await prepareRestart(context);
      status = { ...status, state: 'restarting', targetVersion };
      const completion = handoffRestart({ ...context, restartPreparation }).catch(async (error) => {
        status = { ...status, state: 'rollback', error: error.message };
        await cancelRestart({ restartPreparation, error });
        throw error;
      });
      return { completion };
    }),
  };
}

function createApp({ environment = {}, storedOptions = {}, installer = createInstaller(), platform = 'linux', survivingTransaction = null } = {}) {
  const app = express();
  const processMock = {
    env: environment,
    platform,
    pid: 1234,
    execPath: process.execPath,
    kill: vi.fn(),
  };
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      promises: {
        readFile: vi.fn(async (filePath) => {
          if (String(filePath).endsWith('restart-transaction.json')) {
            if (survivingTransaction) return JSON.stringify(survivingTransaction);
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return JSON.stringify({ launchMode: 'foreground', port: 7897, ...storedOptions });
        }),
        rm: vi.fn(async () => {}),
      },
    },
    os,
    path,
    process: processMock,
    server: { address: () => ({ port: 7897 }) },
    serverStartedAt: '2026-08-26T00:00:00.000Z',
    __dirname: '/opt/openchamber/server',
    openchamberDataDir: '/tmp/openchamber',
    openchamberVersion: '1.0.0',
    modelsDevApiUrl: 'https://models.example.test',
    modelsMetadataCacheTtl: 0,
    readSettingsFromDiskMigrated: vi.fn(),
    fetchFreeZenModels: vi.fn(),
    getCachedZenModels: vi.fn(),
    createValidatedReleaseInstaller: vi.fn(() => installer),
    checkForUpdates,
    spawnSync,
    spawn,
    migrateSystemdServiceToManagedLauncher,
    writeRestartTransaction,
    activateRestartTransaction,
    cancelRestartTransaction,
  };
  registerOpenChamberRoutes(app, dependencies);
  return { app, dependencies, installer };
}

beforeEach(() => {
  checkForUpdates.mockResolvedValue({ available: true, version: '2.0.0', currentVersion: '1.0.0' });
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  migrateSystemdServiceToManagedLauncher.mockReturnValue({ apply: applyService, rollback: rollbackService, rollbackState });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('OpenChamber validated update routes', () => {
  it('uses the canonical managed root for installation and restart recovery', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-route-root-'));
    const actualInstallRoot = path.join(root, 'managed-install');
    const configuredInstallRoot = path.join(root, 'install');
    const transactionId = '12345678-1234-4123-8123-123456789abc';
    try {
      await fsp.mkdir(actualInstallRoot);
      await fsp.symlink(actualInstallRoot, configuredInstallRoot);
      const canonicalInstallRoot = await fsp.realpath(actualInstallRoot);
      const { dependencies } = createApp({
        environment: { OPENCHAMBER_MANAGED_INSTALL_ROOT: configuredInstallRoot },
        survivingTransaction: { schemaVersion: 3, transactionId },
      });
      expect(dependencies.createValidatedReleaseInstaller).toHaveBeenCalledWith(expect.objectContaining({ installRoot: canonicalInstallRoot }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
        '--delayed-fallback',
        path.join(canonicalInstallRoot, 'restart-transaction.json'),
        '--transaction-id',
        transactionId,
      ]), expect.objectContaining({ detached: true }));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('reports available and lifecycle state without claiming installation', async () => {
    const { app, installer } = createApp();
    const response = await request(app).get('/api/openchamber/update-check?appType=web').expect(200);
    expect(installer.checkForUpdate).toHaveBeenCalledOnce();
    expect(response.body).toMatchObject({ available: true, channel: 'j2k', channelRepository: 'jameskorzekwa/openchamber', installation: { state: 'available', targetVersion: '2.0.0' } });

    const statusResponse = await request(app).get('/api/openchamber/update-status').expect(200);
    expect(statusResponse.body).toMatchObject({ state: 'available' });
  });

  it('starts an ID-bound detached fallback for a journal surviving startup', async () => {
    const transactionId = '12345678-1234-4123-8123-123456789abc';
    createApp({ survivingTransaction: { schemaVersion: 3, transactionId } });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
      '--delayed-fallback',
      '--transaction-id',
      transactionId,
    ]), expect.objectContaining({ detached: true }));
  });

  it('rejects installs without an external process manager', async () => {
    const { app, installer } = createApp();
    await request(app).post('/api/openchamber/update-install').expect(409, {
      error: 'In-app updates require an external process manager. Set OPENCHAMBER_SYSTEMD_UNIT under systemd or OPENCHAMBER_UPDATE_RESTART_ON_EXIT=true for another manager.',
    });
    expect(installer.beginInstall).not.toHaveBeenCalled();
  });

  it('accepts installation and hands restart to an external process manager', async () => {
    vi.useFakeTimers();
    const { app, installer, dependencies } = createApp({
      environment: {
        OPENCHAMBER_UPDATE_RESTART_ON_EXIT: 'true',
        OPENCHAMBER_MANAGED_LAUNCHER: path.join(os.homedir(), '.local', 'share', 'openchamber', 'bin', 'openchamber-managed'),
      },
    });
    const response = await request(app).post('/api/openchamber/update-install').expect(202);
    expect(response.body).toMatchObject({ accepted: true, installation: { state: 'restarting', targetVersion: '2.0.0' } });
    await vi.waitFor(() => expect(installer.beginInstall).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(dependencies.process.kill).toHaveBeenCalledWith(1234, 0));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(1, process.execPath, expect.arrayContaining(['--delayed-fallback', '/tmp/openchamber-install/restart-transaction.json', '--transaction-id']), expect.objectContaining({ detached: true }));
    expect(spawn).toHaveBeenNthCalledWith(2, process.execPath, expect.arrayContaining(['/tmp/openchamber-install/restart-transaction.json', '--transaction-id']), expect.objectContaining({ detached: true }));
    await vi.advanceTimersByTimeAsync(250);
    expect(dependencies.process.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
    await request(app).post('/api/openchamber/update-install').expect(409);
    expect(installer.beginInstall).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('queues only the restart through systemd after installation', async () => {
    const { app, installer } = createApp({
      environment: { INVOCATION_ID: 'systemd', OPENCHAMBER_SYSTEMD_UNIT: 'openchamber@home.service' },
    });
    await request(app).post('/api/openchamber/update-install').expect(202);
    await vi.waitFor(() => expect(spawnSync).toHaveBeenCalledTimes(2));
    expect(migrateSystemdServiceToManagedLauncher).toHaveBeenCalledWith(expect.objectContaining({
      unit: 'openchamber@home.service',
      fallbackCliPath: '/opt/openchamber/bin/cli.js',
    }));
    expect(writeRestartTransaction).toHaveBeenCalledWith('/tmp/openchamber-install/restart-transaction.json', expect.objectContaining({
      targetVersion: '2.0.0',
      targetRevision: '2'.repeat(40),
      manager: 'systemd',
      phase: 'prepared',
      systemd: { unit: 'openchamber@home.service', ...rollbackState },
    }));
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'systemd-run', expect.arrayContaining([
      '--on-active=90s',
      '--fallback',
      '/tmp/openchamber-install/restart-transaction.json',
    ]), expect.objectContaining({ timeout: 5000 }));
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'systemd-run', expect.arrayContaining([
      '--collect',
      process.execPath,
      '/tmp/openchamber-install/restart-transaction.json',
    ]), expect.objectContaining({ timeout: 5000 }));
    expect(writeRestartTransaction.mock.invocationCallOrder[0]).toBeLessThan(spawnSync.mock.invocationCallOrder[0]);
    expect(spawnSync.mock.invocationCallOrder[0]).toBeLessThan(applyService.mock.invocationCallOrder[0]);
    expect(installer.beginInstall).toHaveBeenCalledOnce();
  });

  it('does not exit when a durable supervisor helper cannot be launched', async () => {
    spawn.mockReturnValueOnce({ pid: 4321, unref: vi.fn() }).mockReturnValueOnce({ pid: undefined, error: new Error('spawn failed'), unref: vi.fn() });
    const { app, installer, dependencies } = createApp({
      environment: {
        OPENCHAMBER_UPDATE_RESTART_ON_EXIT: 'true',
        OPENCHAMBER_MANAGED_LAUNCHER: path.join(os.homedir(), '.local', 'share', 'openchamber', 'bin', 'openchamber-managed'),
      },
    });
    await request(app).post('/api/openchamber/update-install').expect(202);
    await vi.waitFor(() => expect(installer.getStatus().state).toBe('rollback'));
    expect(dependencies.process.kill).not.toHaveBeenCalled();
    expect(cancelRestartTransaction).toHaveBeenCalled();
  });

  it('restores the systemd service before installer selection rollback when restart handoff fails', async () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'queue failed' });
    const { app } = createApp({ environment: { INVOCATION_ID: 'systemd' } });
    await request(app).post('/api/openchamber/update-install').expect(500);
    await vi.waitFor(() => expect(rollbackService).toHaveBeenCalledOnce());
  });

  it('rejects malformed systemd ownership and concurrent installs', async () => {
    const installer = createInstaller();
    installer.isInstalling.mockReturnValue(true);
    const { app } = createApp({
      environment: { INVOCATION_ID: 'systemd', OPENCHAMBER_SYSTEMD_UNIT: 'openchamber.service;rm' },
      installer,
    });
    await request(app).post('/api/openchamber/update-install').expect(409);
    expect(installer.beginInstall).not.toHaveBeenCalled();
  });
});
