import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildManagedLauncher,
  buildSystemdUserService,
  migrateSystemdServiceToManagedLauncher,
} from './cli-startup.js';

const temporaryDirectories = [];

async function fixture() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-startup-')));
  temporaryDirectories.push(root);
  const systemdRoot = path.join(root, 'systemd');
  const servicePath = path.join(systemdRoot, 'openchamber.service');
  const installRoot = path.join(root, 'install');
  await fsp.mkdir(systemdRoot, { recursive: true });
  const service = '[Unit]\nDescription=Custom\n[Service]\nEnvironment=KEEP=yes\nExecStart="/old/node" "/old/openchamber/bin/cli.js" serve --foreground --port 7897 --host "127.0.0.1" --ui-password "secret with spaces" --custom-flag=value\nRestart=always\n';
  await fsp.writeFile(servicePath, service, { mode: 0o600 });
  return { root, systemdRoot, servicePath, installRoot, service };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

describe('managed startup launcher', () => {
  it('resolves current on every launch and retains only a bootstrap fallback', () => {
    const content = buildManagedLauncher({
      installRoot: '/home/test/.local/share/openchamber',
      launcherPath: '/home/test/.local/share/openchamber/bin/openchamber-managed',
      fallbackCliPath: '/old/package/bin/cli.js',
      nodePath: '/usr/bin/node',
    });
    expect(content).toContain("selected='/home/test/.local/share/openchamber/current/bin/cli.js'");
    expect(content).toContain("export OPENCHAMBER_MANAGED_LAUNCHER='/home/test/.local/share/openchamber/bin/openchamber-managed'");
    expect(content).toContain('exec \'/usr/bin/node\' "$selected" "$@"');
    expect(content).toContain("exec '/usr/bin/node' '/old/package/bin/cli.js' \"$@\"");
  });

  it('builds new systemd services against the stable launcher', () => {
    const service = buildSystemdUserService({ launcherPath: '/stable/openchamber-managed', port: 4567 });
    expect(service).toContain('ExecStart="/stable/openchamber-managed" "serve" "--foreground" "--port" "4567"');
    expect(service).not.toContain(process.execPath);
  });

  it('rewrites only ExecStart, reloads systemd, and restores exact state on rollback', async () => {
    const value = await fixture();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const migration = migrateSystemdServiceToManagedLauncher({
      unit: 'openchamber.service',
      installRoot: value.installRoot,
      fallbackCliPath: '/old/package/bin/cli.js',
      nodePath: '/usr/bin/node',
      servicePath: value.servicePath,
      userSystemdRoot: value.systemdRoot,
      spawnSyncImpl,
    });
    const migrated = await fsp.readFile(value.servicePath, 'utf8');
    expect(migrated).toContain('Environment=KEEP=yes');
    expect(migrated).toContain(`ExecStart="${path.join(value.installRoot, 'bin', 'openchamber-managed')}" serve --foreground --port 7897 --host "127.0.0.1" --ui-password "secret with spaces" --custom-flag=value`);
    expect(spawnSyncImpl).toHaveBeenCalledWith('systemctl', ['--user', 'daemon-reload'], expect.objectContaining({ timeout: 10_000 }));

    migration.rollback();
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(value.service);
    expect(fs.existsSync(path.join(value.installRoot, 'bin', 'openchamber-managed'))).toBe(false);
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
  });

  it('returns rollback state without mutating service state until a deferred plan is applied', async () => {
    const value = await fixture();
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const migration = migrateSystemdServiceToManagedLauncher({
      unit: 'openchamber.service',
      installRoot: value.installRoot,
      fallbackCliPath: '/old/package/bin/cli.js',
      servicePath: value.servicePath,
      userSystemdRoot: value.systemdRoot,
      spawnSyncImpl,
      deferApply: true,
    });
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(value.service);
    expect(fs.existsSync(path.join(value.installRoot, 'bin', 'openchamber-managed'))).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(migration.rollbackState.originalService).toBe(Buffer.from(value.service).toString('base64'));
    migration.apply();
    expect(await fsp.readFile(value.servicePath, 'utf8')).not.toBe(value.service);
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
  });

  it('rolls service and launcher back when daemon-reload fails', async () => {
    const value = await fixture();
    let reloads = 0;
    const spawnSyncImpl = vi.fn(() => {
      reloads += 1;
      return reloads === 1 ? { status: 1, stdout: '', stderr: 'reload failed' } : { status: 0, stdout: '', stderr: '' };
    });
    expect(() => migrateSystemdServiceToManagedLauncher({
      unit: 'openchamber.service',
      installRoot: value.installRoot,
      fallbackCliPath: '/old/package/bin/cli.js',
      servicePath: value.servicePath,
      userSystemdRoot: value.systemdRoot,
      spawnSyncImpl,
    })).toThrow('reload failed');
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(value.service);
    expect(fs.existsSync(path.join(value.installRoot, 'bin', 'openchamber-managed'))).toBe(false);
  });

  it.each([
    ['inline environment', '/usr/bin/env SECRET=value /opt/openchamber serve --foreground'],
    ['Node flags', '/usr/bin/node --enable-source-maps /opt/openchamber/bin/cli.js serve --foreground'],
    ['custom wrapper', '/usr/local/bin/daemonize /opt/openchamber serve --foreground'],
  ])('rejects a noncanonical %s prefix without changing service state', async (_label, execStart) => {
    const value = await fixture();
    const service = value.service.replace(/^ExecStart=.*$/m, `ExecStart=${execStart}`);
    await fsp.writeFile(value.servicePath, service);
    const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(() => migrateSystemdServiceToManagedLauncher({
      unit: 'openchamber.service',
      installRoot: value.installRoot,
      fallbackCliPath: '/old/package/bin/cli.js',
      servicePath: value.servicePath,
      userSystemdRoot: value.systemdRoot,
      spawnSyncImpl,
    })).toThrow('remove inline env, Node flags, or custom wrappers');
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(service);
    expect(fs.existsSync(path.join(value.installRoot, 'bin', 'openchamber-managed'))).toBe(false);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
  });

  it.each(['-', '@', ':', '+', '!', '!!', '|'])('rejects the systemd %s executable control prefix', async (prefix) => {
    const value = await fixture();
    const service = value.service.replace(/^ExecStart=.*$/m, `ExecStart=${prefix}/opt/openchamber serve --foreground --ui-password secret`);
    await fsp.writeFile(value.servicePath, service);
    expect(() => migrateSystemdServiceToManagedLauncher({
      unit: 'openchamber.service',
      installRoot: value.installRoot,
      fallbackCliPath: '/old/package/bin/cli.js',
      servicePath: value.servicePath,
      userSystemdRoot: value.systemdRoot,
      spawnSyncImpl: vi.fn(),
    })).toThrow('unsupported ExecStart control prefix');
    expect(await fsp.readFile(value.servicePath, 'utf8')).toBe(service);
  });
});
