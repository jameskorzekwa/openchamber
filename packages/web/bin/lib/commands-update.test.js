import fs from 'fs';
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

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
        expect(JSON.parse(process.stdout.write.mock.calls[0][0])).toMatchObject({
          installationMethod: 'package-manager',
          packageManager: 'npm',
        });
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
      openchamberArtifact: { platform: 'linux', arch: 'x64', nodeAbi: '127' },
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
