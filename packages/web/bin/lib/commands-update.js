import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJson, requestServerShutdown } from './cli-http.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import {
  readInstanceOptions,
  removePidFile,
  stopInstanceProcess,
} from './cli-process.js';
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

const CHANNEL_VERSION_PATTERN = /^\d+\.\d+\.\d+-j2k\.[1-9]\d*$/;
const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

function isManagedValidatedInstall({
  environment = process.env,
  cliPath = process.argv[1],
  readFileSync = fs.readFileSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const installRoot = environment.OPENCHAMBER_MANAGED_INSTALL_ROOT?.trim();
  const launcher = environment.OPENCHAMBER_MANAGED_LAUNCHER?.trim();
  if (!installRoot || !path.isAbsolute(installRoot) || launcher !== path.join(installRoot, 'bin', 'openchamber-managed')) return false;
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
  requestJsonImpl = requestJson,
  managedInstallDetector = isManagedValidatedInstall,
}) {
  return async function updateCommand(options = {}) {
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
      if (candidates.length !== 1) {
        updateSpin?.error('Managed update server unavailable');
        if (showOutput) clackOutro('update failed');
        throw new Error(options.explicitPort
          ? `No running OpenChamber instance was found on port ${options.port}`
          : 'Managed updates require exactly one running OpenChamber instance; specify one with --port');
      }
      const instance = candidates[0];
      const requestOptions = {
        explicitUiPassword: options.explicitUiPassword,
        uiPassword: options.uiPassword,
        timeoutMs: 30_000,
      };
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

    if (runningInstances.length > 0) {
      updateSpin?.message(`Stopping ${runningInstances.length} running instance(s)...`);
      for (const instance of runningInstances) {
        try {
          const requested = await requestServerShutdown(instance.port, instance.host);
          await stopInstanceProcess(instance.pid, {
            shutdownWaitMs: requested ? 5000 : 0,
            gracefulTimeoutMs: 2500,
            forceTimeoutMs: 3000,
          });
          removePidFile(instance.pidFilePath);
        } catch {
        }
      }
    }

    const result = executeUpdate(packageManager, { silent: isJsonMode(options) || isQuietMode(options) });
    if (!result.success) {
      updateSpin?.error('Update failed');
      if (showOutput) {
        clackOutro('update failed');
      }
      throw new Error(`Update failed with exit code ${result.exitCode}`);
    }

    if (runningInstances.length > 0) {
      updateSpin?.message(`Restarting ${runningInstances.length} instance(s)...`);
      for (const instance of runningInstances) {
        const storedOptions = readInstanceOptions(instance.instanceFilePath) || { port: instance.port };
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
