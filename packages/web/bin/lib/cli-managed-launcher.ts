import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'node:url';

const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;
export const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

function getManagedInstallRoot() {
  return path.join(os.homedir(), '.local', 'share', 'openchamber');
}

export function getManagedLauncherPath() {
  return path.join(getManagedInstallRoot(), 'bin', 'openchamber-managed');
}

type ManagedLauncherOptions = {
  installRoot?: string;
  launcherPath?: string;
  fallbackCliPath?: string;
  nodePath?: string;
};

type SystemdMigrationOptions = ManagedLauncherOptions & {
  unit?: string;
  spawnSyncImpl?: typeof spawnSync;
  servicePath?: string;
  userSystemdRoot?: string;
  deferApply?: boolean;
};

export function systemdEscapeArg(value: string) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function startupShellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const PNPM_STORE_SEGMENT = `${path.sep}.pnpm${path.sep}`;
const PACKAGE_SEGMENT = `${path.sep}node_modules${path.sep}@openchamber${path.sep}web${path.sep}`;

export function stablePnpmEntrypoint(resolved: string, exists = fs.existsSync) {
  const storeIndex = resolved.indexOf(PNPM_STORE_SEGMENT);
  if (storeIndex < 0) return null;
  const packageIndex = resolved.indexOf(PACKAGE_SEGMENT, storeIndex);
  if (packageIndex < 0) return null;
  const stable = path.join(
    resolved.slice(0, storeIndex),
    '@openchamber',
    'web',
    resolved.slice(packageIndex + PACKAGE_SEGMENT.length),
  );
  return exists(stable) ? stable : null;
}

function isPnpmGlobalLinkEntrypoint(invoked: string) {
  const packageIndex = invoked.indexOf(PACKAGE_SEGMENT);
  if (packageIndex < 0) return false;
  const linkPath = invoked.slice(0, packageIndex);
  const layoutDir = path.dirname(linkPath);
  if (!/^v\d+$/.test(path.basename(layoutDir)) || path.basename(path.dirname(layoutDir)) !== 'global') {
    return false;
  }
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function resolveCliEntrypoint() {
  const entry = process.argv[1] !== undefined && process.argv[1].trim().length > 0
    ? process.argv[1]
    : fileURLToPath(new URL('../cli.js', import.meta.url));
  const invoked = path.resolve(entry);
  if (isPnpmGlobalLinkEntrypoint(invoked)) {
    return invoked;
  }
  let resolved;
  try {
    resolved = fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
  return stablePnpmEntrypoint(resolved) ?? resolved;
}

function atomicWriteFileSync(filePath: string, content: string | Uint8Array, mode: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

export function buildManagedLauncher({ installRoot = getManagedInstallRoot(), launcherPath = getManagedLauncherPath(), fallbackCliPath = resolveCliEntrypoint(), nodePath = process.execPath }: ManagedLauncherOptions = {}) {
  const selectedCli = path.join(installRoot, 'current', 'bin', 'cli.js');
  return `#!/bin/sh
set -eu
selected=${startupShellQuote(selectedCli)}
export OPENCHAMBER_MANAGED_LAUNCHER=${startupShellQuote(launcherPath)}
export OPENCHAMBER_MANAGED_INSTALL_ROOT=${startupShellQuote(installRoot)}
if [ -f "$selected" ]; then
  exec ${startupShellQuote(nodePath)} "$selected" "$@"
fi
exec ${startupShellQuote(nodePath)} ${startupShellQuote(fallbackCliPath)} "$@"
`;
}

export function writeManagedLauncher(options: ManagedLauncherOptions = {}) {
  const launcherPath = options.launcherPath || getManagedLauncherPath();
  atomicWriteFileSync(launcherPath, buildManagedLauncher(options), 0o700);
  return launcherPath;
}

function parseSystemdExecStart(value: string) {
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value.charAt(index))) index += 1;
    if (index === value.length) break;
    const start = index;
    let token = '';
    let quote: string | null = null;
    while (index < value.length) {
      const character = value.charAt(index);
      if (!quote && /\s/.test(character)) break;
      if (character === '"' || character === "'") {
        if (!quote) quote = character;
        else if (quote === character) quote = null;
        else token += character;
        index += 1;
        continue;
      }
      if (character === '\\') {
        index += 1;
        if (index === value.length) throw new Error('Systemd ExecStart ends with an incomplete escape');
        token += value.charAt(index);
        index += 1;
        continue;
      }
      token += character;
      index += 1;
    }
    if (quote) throw new Error('Systemd ExecStart contains an unterminated quote');
    tokens.push({ value: token, start });
  }
  return tokens;
}

export function migrateSystemdServiceToManagedLauncher({
  unit,
  installRoot = getManagedInstallRoot(),
  fallbackCliPath = resolveCliEntrypoint(),
  nodePath = process.execPath,
  spawnSyncImpl = spawnSync,
  servicePath: suppliedServicePath,
  userSystemdRoot: suppliedUserSystemdRoot,
  deferApply = false,
}: SystemdMigrationOptions = {}) {
  if (!unit || !SYSTEMD_UNIT_PATTERN.test(unit)) throw new Error('Systemd service unit is invalid');
  let servicePath = suppliedServicePath;
  if (!servicePath) {
    const show = spawnSyncImpl('systemctl', ['--user', 'show', unit, '--property=FragmentPath', '--value'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SYSTEMD_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    if (show.error) throw show.error;
    if (show.status !== 0) throw new Error((show.stderr || show.stdout || '').trim() || `Could not resolve ${unit}`);
    servicePath = (show.stdout || '').trim();
  }
  const userSystemdRoot = suppliedUserSystemdRoot || path.join(os.homedir(), '.config', 'systemd', 'user');
  servicePath = fs.realpathSync(servicePath);
  const canonicalSystemdRoot = fs.realpathSync(userSystemdRoot);
  const relativeServicePath = path.relative(canonicalSystemdRoot, servicePath);
  if (!servicePath || relativeServicePath.startsWith('..') || path.isAbsolute(relativeServicePath) || path.extname(servicePath) !== '.service') {
    throw new Error(`Systemd service ${unit} is not a writable user service`);
  }
  const originalService = fs.readFileSync(servicePath, 'utf8');
  const execMatches = originalService.match(/^ExecStart=.*$/gm) || [];
  const [execStart] = execMatches;
  if (execMatches.length !== 1 || execStart === undefined) throw new Error(`Systemd service ${unit} must contain exactly one ExecStart`);
  const originalExecStart = execStart.slice('ExecStart='.length);
  const execTokens = parseSystemdExecStart(originalExecStart);
  const serveToken = execTokens.find((token, index) => index > 0 && token.value === 'serve');
  if (!serveToken) throw new Error(`Systemd service ${unit} ExecStart must invoke OpenChamber serve`);
  const serveTokenIndex = execTokens.indexOf(serveToken);
  const prefix = execTokens.slice(0, serveTokenIndex).map((token) => token.value);
  const [executable = '', cli = ''] = prefix;
  if (/^[-@:+!|]/.test(executable)) {
    throw new Error(`Systemd service ${unit} uses an unsupported ExecStart control prefix`);
  }
  const directExecutable = prefix.length === 1 ? path.basename(executable).toLowerCase() : '';
  const directLaunch = directExecutable === 'openchamber' || directExecutable === 'openchamber-managed';
  const nodeLaunch = prefix.length === 2
    && ['node', 'nodejs'].includes(path.basename(executable).toLowerCase())
    && path.basename(cli).toLowerCase() === 'cli.js'
    && cli.toLowerCase().includes('openchamber');
  if (!directLaunch && !nodeLaunch) {
    throw new Error(`Systemd service ${unit} uses an unsupported ExecStart prefix; remove inline env, Node flags, or custom wrappers before enabling in-app updates`);
  }
  const preservedArguments = originalExecStart.slice(serveToken.start);
  const launcherPath = path.join(installRoot, 'bin', 'openchamber-managed');
  const launcherExisted = fs.existsSync(launcherPath);
  const originalLauncher = launcherExisted ? fs.readFileSync(launcherPath) : null;
  const launcherMode = launcherExisted ? fs.statSync(launcherPath).mode & 0o777 : 0o700;
  const serviceMode = fs.statSync(servicePath).mode & 0o777;
  const replacement = `ExecStart="${systemdEscapeArg(launcherPath)}" ${preservedArguments}`;
  let migrated = false;
  const rollback = () => {
    if (!migrated) return;
    atomicWriteFileSync(servicePath, originalService, serviceMode);
    if (originalLauncher !== null) atomicWriteFileSync(launcherPath, originalLauncher, launcherMode);
    else {
      try { fs.unlinkSync(launcherPath); } catch { void 0; }
    }
    const reload = spawnSyncImpl('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SYSTEMD_COMMAND_TIMEOUT_MS, windowsHide: true });
    if (reload.error || reload.status !== 0) throw reload.error || new Error((reload.stderr || reload.stdout || '').trim() || 'systemctl --user daemon-reload failed during rollback');
    migrated = false;
  };
  const apply = () => {
    if (migrated) return;
    try {
      writeManagedLauncher({ launcherPath, installRoot, fallbackCliPath, nodePath });
      atomicWriteFileSync(servicePath, originalService.replace(/^ExecStart=.*$/m, replacement), serviceMode);
      const reload = spawnSyncImpl('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SYSTEMD_COMMAND_TIMEOUT_MS, windowsHide: true });
      if (reload.error || reload.status !== 0) throw reload.error || new Error((reload.stderr || reload.stdout || '').trim() || 'systemctl --user daemon-reload failed');
      migrated = true;
    } catch (error) {
      migrated = true;
      try { rollback(); } catch (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : error}; service rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`);
      }
      throw error;
    }
  };
  const result = {
    launcherPath,
    servicePath,
    apply,
    rollback,
    rollbackState: {
      servicePath,
      serviceMode,
      originalService: Buffer.from(originalService).toString('base64'),
      launcherPath,
      launcherExisted,
      launcherMode,
      originalLauncher: originalLauncher ? Buffer.from(originalLauncher).toString('base64') : null,
    },
  };
  if (!deferApply) apply();
  return result;
}
