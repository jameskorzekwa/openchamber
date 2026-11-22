import fs from 'node:fs';
import path from 'node:path';
import { webPackagePaths } from '../../server/lib/web-package-paths.js';
import { requestJson, requestServerShutdown } from './cli-http.js';
import type { JsonRequestOptions } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { buildLocalUrl } from './cli-network.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
  SERVER_SHUTDOWN_GRACE_MS,
  hasInstanceFields,
} from './cli-process.js';
import type { InstanceFileFields } from './cli-process.js';
import { findStartupServiceInstance, restartStartupService } from './cli-startup.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';
import type { CliOptions } from './cli-args.js';
import type { ServeOptions } from './commands-serve.js';
import type { JsonValue } from '../../server/lib/shared/json-values.js';

export type RunningInstance = Awaited<ReturnType<typeof discoverRunningInstances>>[number];

export interface UpdateDependencies {
  importFromFilePath: (filePath: string) => Promise<Pick<typeof import('../../server/lib/package-manager.js'), 'checkForUpdates' | 'executeUpdate' | 'detectPackageManager' | 'getCurrentVersion'>>;
  packageManagerPath: string;
  serveCommand: (options: ServeOptions) => Promise<number>;
  discoverInstances?: () => Promise<RunningInstance[]>;
  startupService?: {
    findInstance: (instances: RunningInstance[]) => RunningInstance | null | undefined;
    restart: typeof restartStartupService;
  };
  waitForVersion?: typeof waitForServerVersion;
  requestJsonImpl?: typeof requestJson;
  managedInstallDetector?: typeof isManagedValidatedInstall;
}

async function waitForServerVersion({ port, host }: Pick<RunningInstance, 'port' | 'host'>, version: JsonValue | undefined, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(buildLocalUrl(port, '/health', host), { signal: AbortSignal.timeout(1000) });
      const body = response.ok ? await response.json() : null;
      if (body && (!version || body.openchamberVersion === version)) {
        return true;
      }
    } catch {
      void 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const CHANNEL_VERSION_PATTERN = /^\d+\.\d+\.\d+-j2k\.[1-9]\d*$/;
const PACKAGE_PATH = webPackagePaths.packageJson;

function isManagedValidatedInstall({
  environment = process.env,
  cliPath = process.argv[1],
  readFileSync = fs.readFileSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const installRoot = environment.OPENCHAMBER_MANAGED_INSTALL_ROOT?.trim();
  const launcher = environment.OPENCHAMBER_MANAGED_LAUNCHER?.trim();
  if (!cliPath || !installRoot || !path.isAbsolute(installRoot) || launcher !== path.join(installRoot, 'bin', 'openchamber-managed')) return false;
  try {
    const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    const artifact = packageJson.openchamberArtifact;
    if (artifact?.constructor !== Object || Object.keys(artifact).sort().join(',') !== 'arch,nodeAbi,platform') return false;
    if (!/^[a-z0-9_-]+$/.test(artifact.platform) || !/^[a-z0-9_-]+$/.test(artifact.arch) || !/^[1-9]\d*$/.test(artifact.nodeAbi)) return false;
    if (packageJson.name !== '@openchamber/web' || !CHANNEL_VERSION_PATTERN.test(packageJson.version)) return false;
    return realpathSync(cliPath) === realpathSync(path.join(installRoot, 'current', 'bin', 'cli.js'));
  } catch {
    return false;
  }
}

function createUpdateCommand({
  importFromFilePath,
  packageManagerPath,
  serveCommand,
  discoverInstances = discoverRunningInstances,
  startupService = {
    findInstance: findStartupServiceInstance,
    restart: restartStartupService,
  },
  waitForVersion = waitForServerVersion,
  requestJsonImpl = requestJson,
  managedInstallDetector = isManagedValidatedInstall,
}: UpdateDependencies) {
  return async function updateCommand(options: Partial<CliOptions> = {}) {
    const showOutput = shouldRenderHumanOutput(options);
    const updateSpin = createSpinner(options);

    const {
      checkForUpdates,
      executeUpdate,
      detectPackageManager,
      getCurrentVersion,
    } = await importFromFilePath(packageManagerPath);

    const currentVersion = getCurrentVersion();
    const managedInstall = managedInstallDetector();
    const packageManager = managedInstall ? null : detectPackageManager();
    const runningInstances = await discoverInstances();

    if (showOutput) {
      clackIntro('OpenChamber Update');
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `current version: ${currentVersion}`);
      logStatus('info', managedInstall ? 'install: validated managed channel' : `install: ${packageManager} package manager`);
    }

    updateSpin?.start(managedInstall ? 'Checking validated channel...' : 'Checking package registry...');

    if (managedInstall) {
      const candidates = options.explicitPort
        ? runningInstances.filter((instance) => instance.port === options.port)
        : runningInstances;
      const [instance] = candidates;
      if (candidates.length !== 1 || !instance) {
        updateSpin?.error('Managed update server unavailable');
        if (showOutput) clackOutro('update failed');
        throw new Error(options.explicitPort
          ? `No running OpenChamber instance was found on port ${options.port}`
          : 'Managed updates require exactly one running OpenChamber instance; specify one with --port');
      }
      const requestOptions: JsonRequestOptions = {
        timeoutMs: 30_000,
      };
      if (options.explicitUiPassword !== undefined) requestOptions.explicitUiPassword = options.explicitUiPassword;
      if (options.uiPassword !== undefined) requestOptions.uiPassword = options.uiPassword;
      const checked = await requestJsonImpl(instance.port, '/api/openchamber/update-check?appType=web', requestOptions);
      if (!checked.response?.ok || checked.body?.error) {
        updateSpin?.error('Validated update check failed');
        if (showOutput) clackOutro('update failed');
        throw new Error(checked.body?.error || `Validated update check failed with HTTP ${checked.response?.status || 'unknown'}`);
      }
      const updateInfo = checked.body;
      if (!updateInfo.available) {
        updateSpin?.stop('Already up to date');
        if (isJsonMode(options)) {
          printJson({ currentVersion, latestVersion: updateInfo.version || currentVersion, updated: false, installationMethod: 'validated-channel' });
        } else if (showOutput) {
          clackOutro('no update needed');
        } else if (isQuietMode(options)) {
          process.stdout.write(`validated-up-to-date ${currentVersion}\n`);
        }
        return;
      }
      updateSpin?.message(`Requesting validated update to ${updateInfo.version}...`);
      const installed = await requestJsonImpl(instance.port, '/api/openchamber/update-install', { ...requestOptions, method: 'POST' });
      if (installed.response?.status !== 202 || installed.body?.accepted !== true) {
        updateSpin?.error('Validated update was not accepted');
        if (showOutput) clackOutro('update failed');
        throw new Error(installed.body?.error || `Validated update install failed with HTTP ${installed.response?.status || 'unknown'}`);
      }
      updateSpin?.stop(`Validated update to ${updateInfo.version} accepted`);
      if (isJsonMode(options)) {
        printJson({ currentVersion, latestVersion: updateInfo.version, updated: true, accepted: true, installationMethod: 'validated-channel' });
      } else if (showOutput) {
        clackOutro('validated update accepted; the process manager will restart OpenChamber');
      } else if (isQuietMode(options)) {
        process.stdout.write(`validated-update-accepted ${updateInfo.version}\n`);
      }
      return;
    }

    const updateInfo = await checkForUpdates();
    if (updateInfo.error) {
      updateSpin?.error('Update check failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(updateInfo.error);
    }
    if (!updateInfo.available) {
      if (isJsonMode(options)) {
        printJson({
          currentVersion,
          latestVersion: updateInfo.version || currentVersion,
          updated: false,
          installationMethod: 'package-manager',
        });
        return;
      }
      if (showOutput && !updateSpin) {
        logStatus('success', 'you are running the latest version');
      }
      updateSpin?.stop('Already up to date');
      if (showOutput) {
        clackOutro('no update needed');
      } else if (isQuietMode(options)) {
        process.stdout.write(`up-to-date ${currentVersion}\n`);
      }
      return;
    }

    if (showOutput && !updateSpin) {
      logStatus('info', `updating ${updateInfo.currentVersion || currentVersion} -> ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.message(`Updating to ${updateInfo.version || 'latest'}...`);

    let serviceInstance;
    try {
      serviceInstance = startupService.findInstance(runningInstances);
    } catch (error) {
      updateSpin?.error('Update stopped');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw error;
    }
    const cliInstances = runningInstances.filter((instance) => instance !== serviceInstance);

    if (cliInstances.length > 0) {
      updateSpin?.message(`Stopping ${cliInstances.length} running instance(s)...`);
      for (const instance of cliInstances) {
        try {
          const requested = await requestServerShutdown(instance.port, instance.host);
          await stopInstanceProcess(instance.pid, {
            shutdownWaitMs: requested ? SERVER_SHUTDOWN_GRACE_MS : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          removePidFile(instance.pidFilePath);
        } catch {
          void 0;
        }
      }
    }

    const result = executeUpdate(packageManager ?? undefined, {
      targetVersion: updateInfo.version,
      silent: isJsonMode(options) || isQuietMode(options),
    });
    if (!result.success) {
      updateSpin?.error(result.error || 'Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(result.error || `Update failed with exit code ${result.exitCode}`);
    }

    if (runningInstances.length > 0) {
      updateSpin?.message(`Restarting ${runningInstances.length} instance(s)...`);
    }
    for (const instance of cliInstances) {
      const storedInput = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
      const storedOptions: InstanceFileFields = hasInstanceFields(storedInput) ? storedInput : { port: instance.port };
      await serveCommand({
        port: storedOptions.port || instance.port,
        host: storedOptions.host,
        explicitPort: true,
        uiPassword: storedOptions.uiPassword,
        suppressStartupSummary: true,
        suppressUiPasswordWarning: true,
        quiet: true,
      });
    }
    if (serviceInstance) {
      try {
        await startupService.restart(serviceInstance);
      } catch (error) {
        updateSpin?.error('Startup service did not restart');
        if (showOutput) {
          clackOutro('update failed');
        }
        throw error;
      }
      if (!await waitForVersion(serviceInstance, updateInfo.version)) {
        updateSpin?.error('Startup service did not restart');
        if (showOutput) {
          clackOutro('update failed');
        }
        throw new Error(`The startup service is not running ${updateInfo.version || 'the new version'}. Run \`openchamber startup enable\` to point it at the new install.`);
      }
    }

    if (showOutput && !updateSpin) {
      logStatus('success', `updated to ${updateInfo.version || 'latest'}`);
    }
    updateSpin?.stop(`Updated to ${updateInfo.version || 'latest'}`);
    if (isJsonMode(options)) {
      printJson({
        currentVersion,
        latestVersion: updateInfo.version || 'latest',
        updated: true,
        restartedCount: runningInstances.length,
        installationMethod: 'package-manager',
        packageManager,
      });
      return;
    }
    if (showOutput) {
      clackOutro('update complete');
    } else if (isQuietMode(options)) {
      process.stdout.write(`package-manager-updated ${updateInfo.version || 'latest'}\n`);
    }
  };
}

export { createUpdateCommand, isManagedValidatedInstall };
