import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand, isManagedValidatedInstall } from './commands-update.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous !== undefined) {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        managedInstallDetector: () => false,
        discoverInstances: vi.fn(async () => []),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
        expect(JSON.parse(process.stdout.write.mock.calls[0][0])).toMatchObject({
          installationMethod: 'package-manager',
          packageManager: 'npm',
        });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  describe('with the startup service running', () => {
    const serviceInstance = {
      pid: 4242,
      port: 3000,
      pidFilePath: '/fake/pid',
      instanceFilePath: '/fake/instance',
      launchMode: 'foreground',
    };

    async function runUpdate({
      serviceVersionReached,
      instances = [serviceInstance],
      serviceInstance: found = serviceInstance,
      findInstance = (running) => (running.includes(found) ? found : null),
      restart = () => {},
    }) {
      const calls = [];
      const serveCommand = vi.fn();
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand,
        discoverInstances: vi.fn(async () => instances),
        startupService: {
          findInstance,
          restart: async (instance) => {
            calls.push(`restart ${instance.pid}`);
            await restart();
          },
        },
        waitForVersion: vi.fn(async (_instance, version) => {
          calls.push(`wait ${version}`);
          return serviceVersionReached;
        }),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'pnpm'),
          executeUpdate: vi.fn(() => {
            calls.push('install');
            return { success: true, exitCode: 0 };
          }),
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });
      return withTempOpenChamberDataDir(async () => {
        const originalWrite = process.stdout.write;
        process.stdout.write = vi.fn(() => true);
        try {
          const error = await updateCommand({ json: true }).then(() => null, (failure) => failure);
          return { calls, serveCommand, error };
        } finally {
          process.stdout.write = originalWrite;
        }
      });
    }

    it('lets the service manager restart it once the install is done', async () => {
      const { calls, serveCommand, error } = await runUpdate({ serviceVersionReached: true });

      expect(error).toBeNull();
      expect(calls).toEqual(['install', 'restart 4242', 'wait 9.9.9']);
      expect(serveCommand).not.toHaveBeenCalled();
    });

    it('fails when the service does not come back on the new version', async () => {
      const { error } = await runUpdate({ serviceVersionReached: false });

      expect(error?.message).toMatch(/not running 9\.9\.9.*openchamber startup enable/);
    });

    it('fails when the service restart fails', async () => {
      const { calls, error } = await runUpdate({
        serviceVersionReached: true,
        restart: () => {
          throw new Error('The startup server did not exit');
        },
      });

      expect(error?.message).toMatch(/did not exit/);
      expect(calls).toEqual(['install', 'restart 4242']);
    });

    it('stops before touching anything when it cannot tell which server is the service', async () => {
      // Stopping an instance starts with a shutdown request to its port.
      const shutdownRequest = vi.fn((_request, response) => response.end());
      const server = http.createServer(shutdownRequest);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const manual = { ...serviceInstance, pid: 999999, port: server.address().port, host: '127.0.0.1' };
      try {
        const { calls, serveCommand, error } = await runUpdate({
          serviceVersionReached: true,
          instances: [serviceInstance, manual],
          findInstance: () => {
            throw new Error('Could not tell which running server belongs to the startup task');
          },
        });

        expect(error?.message).toMatch(/Could not tell/);
        expect(calls).toEqual([]);
        expect(shutdownRequest).not.toHaveBeenCalled();
        expect(serveCommand).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    });

    it('restarts the service and a manual foreground server each their own way', async () => {
      // The Windows case: the running task and a manual server share the
      // foreground launch mode. Only the manual one is stopped and served.
      const manual = { ...serviceInstance, pid: 999999, port: 1 };
      const { calls, serveCommand, error } = await runUpdate({
        serviceVersionReached: true,
        instances: [manual, serviceInstance],
      });

      expect(error).toBeNull();
      expect(calls).toEqual(['install', 'restart 4242', 'wait 9.9.9']);
      expect(serveCommand).toHaveBeenCalledTimes(1);
      expect(serveCommand.mock.calls[0][0]).toMatchObject({ port: 1 });
    });

    it('starts a daemon instance again itself', async () => {
      // Nothing outside the CLI restarts a daemon, so the update still brings
      // it back after the install. Port 1 and a pid past any real range keep
      // the shutdown attempt from touching this machine.
      const daemon = {
        pid: 999999,
        port: 1,
        pidFilePath: '/fake/pid',
        instanceFilePath: '/fake/instance',
        launchMode: 'daemon',
      };
      const { calls, serveCommand, error } = await runUpdate({
        serviceVersionReached: true,
        instances: [daemon],
        serviceInstance: null,
      });

      expect(error).toBeNull();
      expect(calls).toEqual(['install']);
      expect(serveCommand).toHaveBeenCalledTimes(1);
      expect(serveCommand.mock.calls[0][0]).toMatchObject({ port: 1, explicitPort: true });
    });

    it('starts a foreground instance itself when no service owns it', async () => {
      // A manual `serve --foreground` has no manager behind it; treating it as
      // the service would stop it and never bring it back.
      const manual = { ...serviceInstance, pid: 999999, port: 1 };
      const { calls, serveCommand, error } = await runUpdate({
        serviceVersionReached: true,
        instances: [manual],
        serviceInstance: null,
      });

      expect(error).toBeNull();
      expect(calls).toEqual(['install']);
      expect(serveCommand).toHaveBeenCalledTimes(1);
    });
  });

  it('surfaces the installed-version verification failure', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({
        success: false,
        exitCode: 0,
        error: 'Installed @openchamber/web version 1.0.0 does not match target 9.9.9.',
      }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await expect(updateCommand({ json: true })).rejects.toThrow(/does not match target 9\.9\.9/);
        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('routes a validated managed install through authenticated local update endpoints', async () => {
    const originalWrite = process.stdout.write;
    process.stdout.write = vi.fn(() => true);
    const executeUpdate = vi.fn();
    const checkForUpdates = vi.fn();
    const detectPackageManager = vi.fn();
    const requestJsonImpl = vi.fn(async (_port, endpoint, options) => {
      if (endpoint.includes('update-check')) {
        return { response: { ok: true, status: 200 }, body: { available: true, version: '2.0.0-j2k.2' } };
      }
      return { response: { ok: true, status: 202 }, body: { accepted: true } };
    });
    const updateCommand = createUpdateCommand({
      packageManagerPath: '/fake/package-manager.js',
      serveCommand: vi.fn(),
      managedInstallDetector: () => true,
      discoverInstances: vi.fn(async () => [{ port: 3000 }]),
      requestJsonImpl,
      importFromFilePath: vi.fn(async () => ({
        checkForUpdates,
        executeUpdate,
        detectPackageManager,
        getCurrentVersion: vi.fn(() => '2.0.0-j2k.1'),
      })),
    });

    try {
      await updateCommand({ json: true, explicitPort: true, port: 3000, explicitUiPassword: true, uiPassword: 'test-password' });
      expect(requestJsonImpl).toHaveBeenNthCalledWith(1, 3000, '/api/openchamber/update-check?appType=web', expect.objectContaining({ explicitUiPassword: true, uiPassword: 'test-password' }));
      expect(requestJsonImpl).toHaveBeenNthCalledWith(2, 3000, '/api/openchamber/update-install', expect.objectContaining({ method: 'POST', uiPassword: 'test-password' }));
      expect(checkForUpdates).not.toHaveBeenCalled();
      expect(detectPackageManager).not.toHaveBeenCalled();
      expect(executeUpdate).not.toHaveBeenCalled();
      expect(JSON.parse(process.stdout.write.mock.calls[0][0])).toMatchObject({
        updated: true,
        accepted: true,
        installationMethod: 'validated-channel',
      });
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('fails closed when a managed update target is missing or ambiguous', async () => {
    const packageHelpers = {
      checkForUpdates: vi.fn(),
      executeUpdate: vi.fn(),
      detectPackageManager: vi.fn(),
      getCurrentVersion: vi.fn(() => '2.0.0-j2k.1'),
    };
    for (const instances of [[], [{ port: 3000 }, { port: 3001 }]]) {
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        managedInstallDetector: () => true,
        discoverInstances: vi.fn(async () => instances),
        requestJsonImpl: vi.fn(),
        importFromFilePath: vi.fn(async () => packageHelpers),
      });
      await expect(updateCommand({ quiet: true })).rejects.toThrow('exactly one running OpenChamber instance');
    }
    expect(packageHelpers.executeUpdate).not.toHaveBeenCalled();
  });

  it('recognizes only a selected validated artifact launched by the managed wrapper', () => {
    const root = '/home/test/.local/share/openchamber';
    const environment = {
      OPENCHAMBER_MANAGED_INSTALL_ROOT: root,
      OPENCHAMBER_MANAGED_LAUNCHER: `${root}/bin/openchamber-managed`,
    };
    const readFileSync = vi.fn(() => JSON.stringify({
      name: '@openchamber/web',
      version: '2.0.0-j2k.1',
      openchamberArtifact: { platform: 'linux', arch: 'x64', nodeAbi: '137' },
    }));
    const selected = `${root}/releases/2.0.0-j2k.1/bin/cli.js`;
    const realpathSync = vi.fn((value) => value.includes('/current/') ? selected : value);
    expect(isManagedValidatedInstall({ environment, cliPath: selected, readFileSync, realpathSync })).toBe(true);
    expect(isManagedValidatedInstall({ environment: {}, cliPath: selected, readFileSync, realpathSync })).toBe(false);
    expect(isManagedValidatedInstall({
      environment,
      cliPath: selected,
      readFileSync: () => JSON.stringify({ name: '@openchamber/web', version: '2.0.0' }),
      realpathSync,
    })).toBe(false);
  });
});
