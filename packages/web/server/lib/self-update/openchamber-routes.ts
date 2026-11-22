import { publicEnterprisePolicy } from '../enterprise-mode.js';
import { isOpenCodeOlderThan } from '../opencode/compatibility.js';
import { webPackagePaths } from '../web-package-paths.js';
import type { Application, QueryValue } from '../shared/http-contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { UpdateCheckResult } from '../package-manager.js';
import type { DesktopUpdater } from '../../index.js';
import type { createNotificationTemplateRuntime } from '../notifications/template-runtime.js';
import { isString } from '../shared/object-guards.js';
import {
  createValidatedReleaseInstaller as createDefaultValidatedReleaseInstaller,
  resolveManagedInstallRoot,
} from '../openchamber-update/validated-release-installer.js';
import type { RestartContext } from '../openchamber-update/restart-transaction.js';
import { restartHelperArguments } from '../openchamber-update/restart-helper-launch.js';

export interface OpenChamberRouteDependencies {
  fs: typeof import('node:fs');
  os: Pick<typeof import('node:os'), 'homedir'>;
  path: typeof import('node:path');
  process: Pick<NodeJS.Process, 'env' | 'platform' | 'execPath' | 'exit' | 'pid' | 'kill'>;
  server: Pick<import('node:http').Server, 'address' | 'close'>;
  cliEntry?: string;
  openchamberDataDir: string;
  modelsDevApiUrl: string;
  modelsMetadataCacheTtl: number;
  readSettingsFromDiskMigrated: ReturnType<typeof import('../settings/settings-runtime.js').createSettingsRuntime>['readSettingsFromDiskMigrated'];
  fetchFreeZenModels: ReturnType<typeof createNotificationTemplateRuntime>['fetchFreeZenModels'];
  getCachedZenModels: ReturnType<typeof createNotificationTemplateRuntime>['getCachedZenModels'];
  desktopUpdater?: DesktopUpdater | null | undefined;
  getOpenCodeCompatibility: () => Promise<{ version: string | null }>;
  serverStartedAt: string;
  openchamberVersion: string;
  openchamberBuildRevision?: string;
  selfUpdate?: boolean | undefined;
}

interface UpdateRuntimeOverrides {
  createValidatedReleaseInstaller?: typeof createDefaultValidatedReleaseInstaller;
  checkForUpdates?: typeof import('../package-manager.js').checkForUpdates;
  spawnSync?: typeof import('node:child_process').spawnSync;
  spawn?: typeof import('node:child_process').spawn;
  migrateSystemdServiceToManagedLauncher?: typeof import('../../../bin/lib/cli-startup.js').migrateSystemdServiceToManagedLauncher;
  writeRestartTransaction?: typeof import('../openchamber-update/restart-transaction.js').writeRestartTransaction;
  activateRestartTransaction?: typeof import('../openchamber-update/restart-transaction.js').activateRestartTransaction;
  cancelRestartTransaction?: typeof import('../openchamber-update/restart-transaction.js').cancelRestartTransaction;
}

type RouteUpdateInfo = Partial<Omit<UpdateCheckResult, 'currentVersion' | 'body' | 'version' | 'packageManager'>> & {
  version?: UpdateCheckResult['version'] | null;
  packageManager?: string;
  currentVersion?: UpdateCheckResult['currentVersion'];
  body?: string | null | undefined;
  updateOwner?: string;
  installBlocked?: string;
  requiredOpenCodeVersion?: string;
  openCodeVersion?: string;
};

type LaunchOptions = {
  port?: JsonValue;
  daemon?: JsonValue;
  launchMode?: JsonValue;
  host?: JsonValue;
  apiOnly?: JsonValue;
  uiPassword?: JsonValue;
};

const hasLaunchProperties = (value: JsonValue): value is LaunchOptions => value !== null;
const hasErrorName = (value: unknown): value is { name?: unknown } => value !== null && value !== undefined;

type RestartPreparation = { transactionPath: string; transactionId: string; helperArguments: string[] } & (
  { manager: 'systemd'; restartJobName: string } | { manager: 'supervisor' }
);

const SYSTEMD_SERVICE_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;

function resolveSystemdServiceUnit(environment: NodeJS.ProcessEnv) {
  if (!environment.INVOCATION_ID) {
    return null;
  }

  const configuredUnit = isString(environment.OPENCHAMBER_SYSTEMD_UNIT)
    ? environment.OPENCHAMBER_SYSTEMD_UNIT.trim()
    : '';
  const unit = configuredUnit || 'openchamber.service';
  return SYSTEMD_SERVICE_UNIT_PATTERN.test(unit) ? unit : null;
}

function shouldRestartOnUpdateExit(environment: NodeJS.ProcessEnv) {
  const value = isString(environment.OPENCHAMBER_UPDATE_RESTART_ON_EXIT)
    ? environment.OPENCHAMBER_UPDATE_RESTART_ON_EXIT.trim().toLowerCase()
    : '';
  return value === '1' || value === 'true';
}

export const registerOpenChamberRoutes = (app: Application, dependencies: OpenChamberRouteDependencies & UpdateRuntimeOverrides) => {
  const {
    fs,
    os,
    path,
    process,
    server,
    cliEntry = webPackagePaths.cliEntry,
    serverStartedAt,
    openchamberDataDir,
    openchamberVersion,
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
    readSettingsFromDiskMigrated: _readSettingsFromDiskMigrated,
    fetchFreeZenModels,
    getCachedZenModels,
    desktopUpdater,
    getOpenCodeCompatibility,
    selfUpdate = true,
    createValidatedReleaseInstaller = createDefaultValidatedReleaseInstaller,
    checkForUpdates: injectedCheckForUpdates,
    spawnSync: injectedSpawnSync,
    spawn: injectedSpawn,
    migrateSystemdServiceToManagedLauncher: injectedMigrateSystemdService,
    writeRestartTransaction: injectedWriteRestartTransaction,
    activateRestartTransaction: injectedActivateRestartTransaction,
    cancelRestartTransaction: injectedCancelRestartTransaction,
  } = dependencies;
  const managedInstallRoot = resolveManagedInstallRoot(process.env.OPENCHAMBER_MANAGED_INSTALL_ROOT || path.join(os.homedir(), '.local', 'share', 'openchamber'));
  const updateInstaller = createValidatedReleaseInstaller({
    currentVersion: openchamberVersion,
    repository: process.env.OPENCHAMBER_UPDATE_CHANNEL_REPO,
    installRoot: managedInstallRoot,
  });
  void (async () => {
    try {
      const canonicalManagedInstallRoot = await fs.promises.realpath(managedInstallRoot);
      const survivingTransactionPath = path.join(canonicalManagedInstallRoot, 'restart-transaction.json');
      const raw = JSON.parse(await fs.promises.readFile(survivingTransactionPath, 'utf8'));
      if (raw?.schemaVersion !== 3 || raw.transactionId?.constructor !== String) return;
      const spawn = injectedSpawn || (await import('node:child_process')).spawn;
      const fallback = spawn(process.execPath, [...restartHelperArguments(), '--delayed-fallback', survivingTransactionPath, '--transaction-id', raw.transactionId], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      fallback.unref();
    } catch {
      void 0;
    }
  })();

  let desktopRestartError: string | null = null;

  const readOpenCodeShortfall = async (version: UpdateCheckResult['version']) => {
    const { fetchRequiredOpenCodeVersion } = await import('../package-manager.js');
    const requiredOpenCodeVersion = await fetchRequiredOpenCodeVersion(version);
    if (!requiredOpenCodeVersion) return null;
    const openCodeVersion = (await getOpenCodeCompatibility().catch(() => null))?.version ?? null;
    return openCodeVersion && isOpenCodeOlderThan(openCodeVersion, requiredOpenCodeVersion)
      ? { requiredOpenCodeVersion, openCodeVersion }
      : null;
  };

  const readLaunchState = async () => {
    const address = server.address();
    const currentPort = (address && !isString(address) ? address.port : undefined) || 3000;
    const instanceFilePath = path.join(openchamberDataDir, 'run', `openchamber-${currentPort}.json`);
    let storedOptions: JsonValue = { port: currentPort, daemon: true };
    try {
      const content = await fs.promises.readFile(instanceFilePath, 'utf8');
      storedOptions = JSON.parse(content);
    } catch {
      void 0;
    }
    if (!hasLaunchProperties(storedOptions)) throw new TypeError("Cannot read properties of null (reading 'launchMode')");
    const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
    const isForegroundService = launchMode === 'foreground';
    const systemdServiceUnit = isForegroundService ? resolveSystemdServiceUnit(process.env) : null;
    return { currentPort, storedOptions, launchMode, isForegroundService, systemdServiceUnit };
  };

  app.get('/api/openchamber/enterprise-policy', (_req, res) => {
    res.json(publicEnterprisePolicy());
  });

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const parseString = (value: QueryValue | undefined) => (isString(value) && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value: string | undefined) => {
        if (value === undefined) return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua: string) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = isString(req.headers['user-agent']) ? req.headers['user-agent'] : '';
      const appType = parseString(req.query.appType) || 'web';
      if (process.env.OPENCHAMBER_RUNTIME === 'desktop' && appType === 'web') {
        if (desktopRestartError && req.query.updateStatus === 'true') {
          return res.status(503).json({
            code: 'DESKTOP_UPDATE_RESTART_FAILED',
            error: desktopRestartError,
          });
        }
        if (!desktopUpdater) {
          return res.status(503).json({
            available: false,
            code: 'DESKTOP_UPDATER_UNAVAILABLE',
            error: 'The desktop updater is not available.',
          });
        }
        return res.json({
          ...await desktopUpdater.check(),
          packageManager: 'electron',
          updateOwner: 'electron-updater',
        });
      }
      if (appType === 'web' && !selfUpdate) {
        return res.json({
          available: false,
          currentVersion: openchamberVersion,
          version: null,
          updateOwner: 'external',
          installation: updateInstaller.getStatus(),
        });
      }
      let updateInfo: RouteUpdateInfo = appType === 'web'
        ? await updateInstaller.checkForUpdate()
        : await (injectedCheckForUpdates || (await import('../package-manager.js')).checkForUpdates)({
          appType,
          deviceClass: parseString(req.query.deviceClass) || inferDeviceClass(userAgent),
          platform: parseString(req.query.platform),
          arch: parseString(req.query.arch),
          instanceMode: parseString(req.query.instanceMode),
          currentVersion: parseString(req.query.currentVersion),
          installId: parseString(req.query.installId),
          reportUsage: parseReportUsage(parseString(req.query.reportUsage)),
        });
      if (appType === 'web' && updateInfo?.available) {
        const openCodeShortfall = await readOpenCodeShortfall(updateInfo.version ?? undefined);
        const { isForegroundService, systemdServiceUnit } = await readLaunchState();
        const exitHandoff = isForegroundService && process.platform !== 'win32' && shouldRestartOnUpdateExit(process.env);
        if (openCodeShortfall) updateInfo = { ...updateInfo, installBlocked: 'opencode-version', ...openCodeShortfall };
        else if (!systemdServiceUnit && !exitHandoff) updateInfo = { ...updateInfo, installBlocked: 'service-manager' };
      }
      res.json({ ...updateInfo, installation: updateInstaller.getStatus() });
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.get('/api/openchamber/release-notes', async (req, res) => {
    const { fetchReleaseNotes, VERSION_PATTERN, CANARY_VERSION_PATTERN } = await import('../changelog/update-notes.js');
    const isVersion = (value: string) => VERSION_PATTERN.test(value) || CANARY_VERSION_PATTERN.test(value);
    const version = String(req.query.version ?? '');
    const since = req.query.since === undefined ? undefined : String(req.query.since);
    if (!isVersion(version) || (since !== undefined && !isVersion(since))) {
      return res.status(400).json({ error: 'version and since must be OpenChamber versions' });
    }
    const { compareVersions } = await import('../version-order.js');
    const releases = await fetchReleaseNotes(version, since, compareVersions);
    if (!releases) {
      return res.status(502).json({ error: 'Release notes are unavailable' });
    }
    res.json({ releases });
  });

  app.get('/api/openchamber/update-status', (_req, res) => {
    res.json(updateInstaller.getStatus());
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      if (!selfUpdate) {
        return res.status(409).json({
          code: 'UPDATE_OWNER_EXTERNAL',
          error: 'OpenChamber updates are managed by the host, not from this UI.',
        });
      }
      if (process.env.OPENCHAMBER_RUNTIME === 'desktop') {
        if (!desktopUpdater) {
          return res.status(503).json({
            code: 'DESKTOP_UPDATER_UNAVAILABLE',
            error: 'The desktop updater is not available.',
          });
        }

        desktopRestartError = null;
        const desktopUpdateInfo = await desktopUpdater.install();
        if (!desktopUpdateInfo?.available) {
          return res.status(400).json({ error: 'No update available' });
        }
        if (desktopUpdateInfo.installBlocked === 'desktop-host') {
          return res.status(409).json({
            code: 'DESKTOP_UPDATE_LOCAL_ONLY',
            error: 'Update OpenChamber on the computer it runs on.',
          });
        }

        res.json({
          success: true,
          message: 'Desktop update downloaded, host will restart shortly',
          version: desktopUpdateInfo.version,
          packageManager: 'electron',
          updateOwner: 'electron-updater',
          autoRestart: true,
          restartManager: 'electron-updater',
        });

        setImmediate(() => {
          Promise.resolve()
            .then(() => desktopUpdater.restart())
            .catch((error) => {
              desktopRestartError = error instanceof Error ? error.message : 'Failed to restart after desktop update';
              console.error('Failed to restart after desktop update:', error);
            });
        });
        return;
      }

      const spawnSync = injectedSpawnSync || (await import('child_process')).spawnSync;
      const spawn = injectedSpawn || (await import('child_process')).spawn;

      if (updateInstaller.isInstalling()) {
        return res.status(409).json({ error: 'An OpenChamber update is already in progress', installation: updateInstaller.getStatus() });
      }

      const updateInfo = await updateInstaller.checkForUpdate();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const openCodeShortfall = await readOpenCodeShortfall(updateInfo.version ?? undefined);
      if (openCodeShortfall) {
        return res.status(409).json({
          code: 'OPENCODE_TOO_OLD',
          error: `OpenChamber ${updateInfo.version} needs OpenCode ${openCodeShortfall.requiredOpenCodeVersion}. This server has ${openCodeShortfall.openCodeVersion}. Update OpenCode first.`,
          ...openCodeShortfall,
        });
      }

      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        return res.status(409).json({ error: 'Container updates must be installed by the container manager' });
      }

      const { currentPort, isForegroundService, systemdServiceUnit } = await readLaunchState();
      const usesExitHandoff = isForegroundService && process.platform !== 'win32' && shouldRestartOnUpdateExit(process.env);
      const expectedManagedLauncher = path.join(os.homedir(), '.local', 'share', 'openchamber', 'bin', 'openchamber-managed');
      if (!systemdServiceUnit && !usesExitHandoff) {
        return res.status(409).json({
          error: 'In-app updates require an external process manager. Set OPENCHAMBER_SYSTEMD_UNIT under systemd or OPENCHAMBER_UPDATE_RESTART_ON_EXIT=true for another manager.',
        });
      }
      if (usesExitHandoff && process.env.OPENCHAMBER_MANAGED_LAUNCHER !== expectedManagedLauncher) {
        return res.status(409).json({ error: `External process managers must launch ${expectedManagedLauncher} before in-app updates are enabled.` });
      }

      const prepareRestart = async (context: RestartContext): Promise<RestartPreparation> => {
        const transactionPath = path.join(context.installRoot, 'restart-transaction.json');
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const writeRestartTransaction = injectedWriteRestartTransaction || restartTransaction.writeRestartTransaction;
        const { randomBytes, randomUUID } = await import('node:crypto');
        const helperArguments = restartHelperArguments();
        const transactionId = randomUUID();
        const commonTransaction = {
          schemaVersion: 3,
          phase: 'prepared',
          ...context,
          healthUrl: `http://127.0.0.1:${currentPort}/health`,
          transactionId,
          attestationSecret: randomBytes(32).toString('hex'),
          origin: { pid: process.pid, startedAt: serverStartedAt },
        };
        if (systemdServiceUnit) {
          const migrateSystemdServiceToManagedLauncher = injectedMigrateSystemdService
            || (await import('../../../bin/lib/cli-startup.js')).migrateSystemdServiceToManagedLauncher;
          const migration = migrateSystemdServiceToManagedLauncher({
            unit: systemdServiceUnit,
            installRoot: context.installRoot,
            fallbackCliPath: cliEntry,
            nodePath: process.execPath,
            spawnSyncImpl: spawnSync,
            deferApply: true,
          });
          const restartJobName = `openchamber-restart-${Date.now()}`;
          try {
            await writeRestartTransaction(transactionPath, {
              ...commonTransaction,
              manager: 'systemd',
              systemd: { unit: systemdServiceUnit, ...migration.rollbackState },
            });
            const fallbackRun = spawnSync('systemd-run', [
              '--user',
              `--unit=${restartJobName}-fallback`,
              '--collect',
              '--on-active=90s',
              process.execPath,
              ...helperArguments,
              '--fallback',
              transactionPath,
              '--transaction-id',
              transactionId,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
            if (fallbackRun.status !== 0) {
              const detail = (fallbackRun.stderr || fallbackRun.stdout || '').trim();
              throw new Error(detail || `Could not schedule rollback guard for ${systemdServiceUnit}`);
            }
            migration.apply();
          } catch (error) {
            await fs.promises.rm(transactionPath, { force: true }).catch(() => {});
            migration.rollback();
            throw error;
          }
          return { transactionPath, transactionId, helperArguments, restartJobName, manager: 'systemd' };
        }
        try {
          await writeRestartTransaction(transactionPath, {
            ...commonTransaction,
            manager: 'supervisor',
            systemd: null,
          });
          const helperOptions: import('node:child_process').SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true };
          const fallback = spawn(process.execPath, [...helperArguments, '--delayed-fallback', transactionPath, '--transaction-id', transactionId], helperOptions);
          fallback.unref();
          if (fallback.pid === undefined || !Number.isInteger(fallback.pid) || fallback.pid <= 0) throw new Error('Could not start the restart transaction fallback helper');
        } catch (error) {
          await fs.promises.rm(transactionPath, { force: true }).catch(() => {});
          throw error;
        }
        return { transactionPath, transactionId, helperArguments, manager: 'supervisor' };
      };

      const handoffRestart = async ({ restartPreparation }: { restartPreparation: RestartPreparation | null }) => {
        if (!restartPreparation) throw new Error('Restart transaction was not prepared');
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const activateRestartTransaction = injectedActivateRestartTransaction || restartTransaction.activateRestartTransaction;
        await activateRestartTransaction(restartPreparation.transactionPath, restartPreparation.transactionId);
        if (restartPreparation.manager === 'systemd') {
          const systemdRun = spawnSync('systemd-run', [
            '--user',
            `--unit=${restartPreparation.restartJobName}`,
            '--collect',
            process.execPath,
            ...restartPreparation.helperArguments,
            restartPreparation.transactionPath,
            '--transaction-id',
            restartPreparation.transactionId,
          ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
          if (systemdRun.status !== 0) {
            const detail = (systemdRun.stderr || systemdRun.stdout || '').trim();
            throw new Error(detail || `Could not hand restart to ${systemdServiceUnit}`);
          }
          return;
        }
        const helperOptions: import('node:child_process').SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: true };
        const primary = spawn(process.execPath, [...restartPreparation.helperArguments, restartPreparation.transactionPath, '--transaction-id', restartPreparation.transactionId], helperOptions);
        primary.unref();
        if (primary.pid === undefined || !Number.isInteger(primary.pid) || primary.pid <= 0) throw new Error('Could not start the restart transaction helper');
        process.kill(process.pid, 0);
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref?.();
      };

      const cancelRestart = async ({ restartPreparation }: { restartPreparation: RestartPreparation | null }) => {
        if (!restartPreparation) throw new Error('Restart transaction was not prepared');
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const cancelRestartTransaction = injectedCancelRestartTransaction || restartTransaction.cancelRestartTransaction;
        const cancelled = await cancelRestartTransaction(restartPreparation.transactionPath, restartPreparation.transactionId);
        if (!cancelled) throw new Error('Restart transaction cancellation could not acquire ownership');
      };

      let completion;
      try {
        if (!updateInfo.version) throw new Error('Validated update has no target version');
        ({ completion } = await updateInstaller.beginInstall({ targetVersion: updateInfo.version, prepareRestart, handoffRestart, cancelRestart }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not acquire the OpenChamber update lock';
        const statusCode = /already in progress|installation lock/.test(message) ? 409 : 500;
        return res.status(statusCode).json({ error: message, installation: updateInstaller.getStatus() });
      }
      void completion.catch((error) => {
        console.error('Failed to install validated OpenChamber update:', error);
      });
      return res.status(202).json({ accepted: true, installation: updateInstaller.getStatus() });
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/openchamber/models-metadata', async (_req, res) => {
    try {
      const { getModelsMetadata, toClientModelsMetadata } = await import('../opencode/models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(toClientModelsMetadata(metadata));
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = hasErrorName(error) && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 504 : 502;
      res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
    }
  });

  app.get('/api/zen/models', async (_req, res) => {
    try {
      const models = await fetchFreeZenModels();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ models });
    } catch (error) {
      console.warn('Failed to fetch zen models:', error);
      const cachedZenModels = getCachedZenModels();
      if (cachedZenModels) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.json(cachedZenModels);
      } else {
        const statusCode = hasErrorName(error) && error.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
