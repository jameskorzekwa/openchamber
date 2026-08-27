import { createValidatedReleaseInstaller as createDefaultValidatedReleaseInstaller } from '../openchamber-update/validated-release-installer.js';

const SYSTEMD_SERVICE_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;

function resolveSystemdServiceUnit(environment) {
  if (!environment.INVOCATION_ID) {
    return null;
  }

  const configuredUnit = typeof environment.OPENCHAMBER_SYSTEMD_UNIT === 'string'
    ? environment.OPENCHAMBER_SYSTEMD_UNIT.trim()
    : '';
  const unit = configuredUnit || 'openchamber.service';
  return SYSTEMD_SERVICE_UNIT_PATTERN.test(unit) ? unit : null;
}

function shouldRestartOnUpdateExit(environment) {
  const value = typeof environment.OPENCHAMBER_UPDATE_RESTART_ON_EXIT === 'string'
    ? environment.OPENCHAMBER_UPDATE_RESTART_ON_EXIT.trim().toLowerCase()
    : '';
  return value === '1' || value === 'true';
}

export const registerOpenChamberRoutes = (app, dependencies) => {
  const {
    fs,
    os,
    path,
    process,
    server,
    serverStartedAt,
    __dirname,
    openchamberDataDir,
    openchamberVersion,
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
    readSettingsFromDiskMigrated,
    fetchFreeZenModels,
    getCachedZenModels,
    createValidatedReleaseInstaller = createDefaultValidatedReleaseInstaller,
    checkForUpdates: injectedCheckForUpdates,
    spawnSync: injectedSpawnSync,
    spawn: injectedSpawn,
    migrateSystemdServiceToManagedLauncher: injectedMigrateSystemdService,
    writeRestartTransaction: injectedWriteRestartTransaction,
    activateRestartTransaction: injectedActivateRestartTransaction,
    cancelRestartTransaction: injectedCancelRestartTransaction,
  } = dependencies;
  const updateInstaller = createValidatedReleaseInstaller({
    currentVersion: openchamberVersion,
    repository: process.env.OPENCHAMBER_UPDATE_CHANNEL_REPO,
  });
  const managedInstallRoot = path.join(os.homedir(), '.local', 'share', 'openchamber');
  const survivingTransactionPath = path.join(managedInstallRoot, 'restart-transaction.json');
  void (async () => {
    try {
      const raw = JSON.parse(await fs.promises.readFile(survivingTransactionPath, 'utf8'));
      if (raw?.schemaVersion !== 3 || raw.transactionId?.constructor !== String) return;
      const { fileURLToPath } = await import('node:url');
      const spawn = injectedSpawn || (await import('node:child_process')).spawn;
      const helperPath = fileURLToPath(new URL('../openchamber-update/restart-transaction.js', import.meta.url));
      const fallback = spawn(process.execPath, [helperPath, '--delayed-fallback', survivingTransactionPath, '--transaction-id', raw.transactionId], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      fallback.unref();
    } catch {}
  })();

  app.get('/api/openchamber/update-check', async (req, res) => {
    try {
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
      const parseReportUsage = (value) => {
        if (typeof value !== 'string') return true;
        const normalized = value.trim().toLowerCase();
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return true;
      };
      const inferDeviceClass = (ua) => {
        const value = (ua || '').toLowerCase();
        if (!value) return 'unknown';
        if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
        if (value.includes('mobi') || value.includes('android') || value.includes('iphone')) return 'mobile';
        return 'desktop';
      };
      const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';

      const appType = parseString(req.query.appType) || 'web';
      const updateInfo = appType === 'web'
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
      res.json({ ...updateInfo, installation: updateInstaller.getStatus() });
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.get('/api/openchamber/update-status', (_req, res) => {
    res.json(updateInstaller.getStatus());
  });

  app.post('/api/openchamber/update-install', async (_req, res) => {
    try {
      const spawnSync = injectedSpawnSync || (await import('child_process')).spawnSync;
      const spawn = injectedSpawn || (await import('child_process')).spawn;

      if (updateInstaller.isInstalling()) {
        return res.status(409).json({ error: 'An OpenChamber update is already in progress', installation: updateInstaller.getStatus() });
      }

      const updateInfo = await updateInstaller.checkForUpdate();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        return res.status(409).json({ error: 'Container updates must be installed by the container manager' });
      }

      const currentPort = server.address()?.port || 3000;
      const instanceFilePath = path.join(openchamberDataDir, 'run', `openchamber-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
      }
      const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
      const isForegroundService = launchMode === 'foreground';
      const systemdServiceUnit = isForegroundService ? resolveSystemdServiceUnit(process.env) : null;
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

      const prepareRestart = async (context) => {
        const transactionPath = path.join(context.installRoot, 'restart-transaction.json');
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const writeRestartTransaction = injectedWriteRestartTransaction || restartTransaction.writeRestartTransaction;
        const { fileURLToPath } = await import('node:url');
        const { randomBytes, randomUUID } = await import('node:crypto');
        const helperPath = fileURLToPath(new URL('../openchamber-update/restart-transaction.js', import.meta.url));
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
            fallbackCliPath: path.resolve(__dirname, '..', 'bin', 'cli.js'),
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
              helperPath,
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
          return { transactionPath, transactionId, helperPath, restartJobName, migration, manager: 'systemd' };
        }
        try {
          await writeRestartTransaction(transactionPath, {
            ...commonTransaction,
            manager: 'supervisor',
            systemd: null,
          });
          const helperOptions = { detached: true, stdio: 'ignore', windowsHide: true };
          const fallback = spawn(process.execPath, [helperPath, '--delayed-fallback', transactionPath, '--transaction-id', transactionId], helperOptions);
          fallback.unref();
          if (!Number.isInteger(fallback.pid) || fallback.pid <= 0) throw fallback.error || new Error('Could not start the restart transaction fallback helper');
        } catch (error) {
          await fs.promises.rm(transactionPath, { force: true }).catch(() => {});
          throw error;
        }
        return { transactionPath, transactionId, helperPath, manager: 'supervisor' };
      };

      const handoffRestart = async ({ restartPreparation }) => {
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const activateRestartTransaction = injectedActivateRestartTransaction || restartTransaction.activateRestartTransaction;
        await activateRestartTransaction(restartPreparation.transactionPath, restartPreparation.transactionId);
        if (restartPreparation.manager === 'systemd') {
          const systemdRun = spawnSync('systemd-run', [
            '--user',
            `--unit=${restartPreparation.restartJobName}`,
            '--collect',
            process.execPath,
            restartPreparation.helperPath,
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
        const helperOptions = { detached: true, stdio: 'ignore', windowsHide: true };
        const primary = spawn(process.execPath, [restartPreparation.helperPath, restartPreparation.transactionPath, '--transaction-id', restartPreparation.transactionId], helperOptions);
        primary.unref();
        if (!Number.isInteger(primary.pid) || primary.pid <= 0) throw primary.error || new Error('Could not start the restart transaction helper');
        process.kill(process.pid, 0);
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250).unref?.();
      };

      const cancelRestart = async ({ restartPreparation }) => {
        const restartTransaction = await import('../openchamber-update/restart-transaction.js');
        const cancelRestartTransaction = injectedCancelRestartTransaction || restartTransaction.cancelRestartTransaction;
        const cancelled = await cancelRestartTransaction(restartPreparation.transactionPath, restartPreparation.transactionId);
        if (!cancelled) throw new Error('Restart transaction cancellation could not acquire ownership');
      };

      let completion;
      try {
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
      const { getModelsMetadata } = await import('./models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502;
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
        const statusCode = error?.name === 'AbortError' ? 504 : 502;
        res.status(statusCode).json({ error: 'Failed to retrieve zen models' });
      }
    }
  });
};
