import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { DEFAULT_PORT } from './cli-args.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { getDataDir } from './cli-paths.js';
import { hasUiPasswordConfigured } from './cli-network.js';
import { searchPathFor } from './cli-executables.js';

const STARTUP_SERVICE_ID = 'dev.openchamber.web';
const SYSTEMD_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;
const SYSTEMD_COMMAND_TIMEOUT_MS = 10_000;

function getManagedInstallRoot() {
  return path.join(os.homedir(), '.local', 'share', 'openchamber');
}

function getManagedLauncherPath() {
  return path.join(getManagedInstallRoot(), 'bin', 'openchamber-managed');
}

function getStartupServicePaths() {
  if (process.platform === 'darwin') {
    return {
      platform: 'macos',
      servicePath: path.join(os.homedir(), 'Library', 'LaunchAgents', `${STARTUP_SERVICE_ID}.plist`),
    };
  }
  if (process.platform === 'linux') {
    return {
      platform: 'linux',
      servicePath: path.join(os.homedir(), '.config', 'systemd', 'user', 'openchamber.service'),
    };
  }
  if (process.platform === 'win32') {
    return { platform: 'windows', servicePath: STARTUP_SERVICE_ID };
  }
  return { platform: process.platform, servicePath: null };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdEscapeArg(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function startupShellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdUnitPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/ /g, '\\x20');
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startupEnvFileQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function systemdEnvFileQuote(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')}"`;
}

function getStartupEnvFilePath() {
  return path.join(getDataDir(), 'startup.env');
}

function getMacosStartupWrapperPath() {
  return path.join(getDataDir(), 'bin', 'OpenChamber');
}

function getWindowsStartupWrapperPath() {
  return path.join(getDataDir(), 'bin', 'OpenChamber.ps1');
}

function collectStartupEnv(options = {}) {
  const env = options.envSnapshot === false ? {} : Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => shouldPersistStartupEnv(key, value))
      .map(([key, value]) => [key, String(value)])
  );

  if (options.envSnapshot !== false) {
    const opencodeBinary = process.env.OPENCODE_BINARY || searchPathFor('opencode');
    if (typeof opencodeBinary === 'string' && opencodeBinary.trim().length > 0) {
      env.OPENCODE_BINARY = opencodeBinary.trim();
    }
  }
  const uiPassword = hasUiPasswordConfigured(options.uiPassword) ? options.uiPassword : undefined;
  if (uiPassword) {
    env.OPENCHAMBER_UI_PASSWORD = uiPassword;
  }
  if (options.apiOnly === true) {
    env.OPENCHAMBER_API_ONLY = 'true';
  }
  if (typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.trim().length > 0) {
    env.OPENCHAMBER_DATA_DIR = path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim());
  }
  return env;
}

function shouldPersistStartupEnv(key, value) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return false;
  if (typeof value !== 'string') return false;
  if (/[\r\n]/.test(value)) return false;

  // These are shell/session implementation details, not app configuration.
  const volatileKeys = new Set([
    '_',
    'BASH_ENV',
    'COLUMNS',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
    'CONDA_PROMPT_MODIFIER',
    'CONDA_SHLVL',
    'ENV',
    'HISTFILE',
    'HISTFILESIZE',
    'HISTSIZE',
    'LINES',
    'OLDPWD',
    'PROMPT',
    'PROMPT_COMMAND',
    'PS1',
    'PS2',
    'PS3',
    'PS4',
    'PWD',
    'PYENV_VERSION',
    'SHLVL',
    'TERM',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TTY',
    'VIRTUAL_ENV',
    'VIRTUAL_ENV_PROMPT',
  ]);
  return !volatileKeys.has(key);
}

function writeStartupEnvFile(options = {}, fileOptions = {}) {
  const envFilePath = getStartupEnvFilePath();
  const lines = [];
  const env = collectStartupEnv(options);
  const quoteValue = typeof fileOptions.quoteValue === 'function' ? fileOptions.quoteValue : startupEnvFileQuote;
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${quoteValue(value)}`);
  }
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envFilePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return envFilePath;
}

function removeStartupEnvFile() {
  try { fs.unlinkSync(getStartupEnvFilePath()); } catch {}
}

function resolveCliEntrypoint() {
  const entry = typeof process.argv[1] === 'string' && process.argv[1].trim().length > 0
    ? process.argv[1]
    : path.join(__dirname, 'cli.js');
  try {
    return fs.realpathSync(entry);
  } catch {
    return path.resolve(entry);
  }
}

function buildStartupArgs(options = {}) {
  const args = [resolveCliEntrypoint(), 'serve', '--foreground', '--port', String(options.port || DEFAULT_PORT)];
  if (typeof options.host === 'string' && options.host.length > 0) {
    args.push('--host', options.host);
  }
  if (options.apiOnly === true) {
    args.push('--api-only');
  }
  return args;
}

function buildServeArgs(options = {}) {
  return buildStartupArgs(options).slice(1);
}

function atomicWriteFileSync(filePath, content, mode) {
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

function buildManagedLauncher({ installRoot = getManagedInstallRoot(), launcherPath = getManagedLauncherPath(), fallbackCliPath = resolveCliEntrypoint(), nodePath = process.execPath } = {}) {
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

function writeManagedLauncher(options = {}) {
  const launcherPath = options.launcherPath || getManagedLauncherPath();
  atomicWriteFileSync(launcherPath, buildManagedLauncher(options), 0o700);
  return launcherPath;
}

function writeMacosStartupWrapper(options = {}) {
  const wrapperPath = getMacosStartupWrapperPath();
  const launcherPath = writeManagedLauncher(options);
  const args = buildServeArgs(options).map(startupShellQuote).join(' ');
  const content = `#!/bin/sh
exec ${startupShellQuote(launcherPath)} ${args}
`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, content, { mode: 0o700 });
  return wrapperPath;
}

function writeWindowsStartupWrapper(options = {}) {
  const wrapperPath = getWindowsStartupWrapperPath();
  const envFilePath = getStartupEnvFilePath();
  const startupArgs = buildStartupArgs(options).map(powershellQuote).join(' ');
  const ps1Content = [
    `$envFile=${powershellQuote(envFilePath)}`,
    `if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $v=$matches[2]; if ($v.StartsWith("'") -and $v.EndsWith("'")) { $v=$v.Substring(1,$v.Length-2).Replace("'\\''","'") }; [Environment]::SetEnvironmentVariable($matches[1], $v, 'Process') } } }`,
    `& ${powershellQuote(process.execPath)} ${startupArgs}`,
  ].join('; ');
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapperPath, ps1Content, { mode: 0o700 });
  return wrapperPath;
}

function buildWindowsStartupTaskCommand(wrapperPath) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${wrapperPath}"`;
}

function buildMacosLaunchAgent(options = {}) {
  const wrapperPath = writeMacosStartupWrapper(options);
  const args = [wrapperPath];
  const env = collectStartupEnv(options);
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'OpenChamber');
  const argXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const envXml = Object.entries(env).length > 0
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${STARTUP_SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envXml}  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(os.homedir())}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, 'startup.err.log'))}</string>
</dict>
</plist>
`;
}

function buildSystemdUserService(options = {}) {
  const launcherPath = options.launcherPath || getManagedLauncherPath();
  const args = buildServeArgs(options).map((arg) => `"${systemdEscapeArg(arg)}"`).join(' ');
  const envFilePath = getStartupEnvFilePath();
  return `[Unit]
Description=OpenChamber web server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-${systemdEscapeArg(envFilePath)}
ExecStart="${systemdEscapeArg(launcherPath)}" ${args}
WorkingDirectory=${systemdUnitPath(os.homedir())}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function parseSystemdExecStart(value) {
  const tokens = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index])) index += 1;
    if (index === value.length) break;
    const start = index;
    let token = '';
    let quote = null;
    while (index < value.length) {
      const character = value[index];
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
        token += value[index];
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

function migrateSystemdServiceToManagedLauncher({
  unit,
  installRoot = getManagedInstallRoot(),
  fallbackCliPath = resolveCliEntrypoint(),
  nodePath = process.execPath,
  spawnSyncImpl = spawnSync,
  servicePath: suppliedServicePath,
  userSystemdRoot: suppliedUserSystemdRoot,
  deferApply = false,
} = {}) {
  if (!SYSTEMD_UNIT_PATTERN.test(unit || '')) throw new Error('Systemd service unit is invalid');
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
  if (execMatches.length !== 1) throw new Error(`Systemd service ${unit} must contain exactly one ExecStart`);
  const originalExecStart = execMatches[0].slice('ExecStart='.length);
  const execTokens = parseSystemdExecStart(originalExecStart);
  const serveTokenIndex = execTokens.findIndex((token, index) => index > 0 && token.value === 'serve');
  if (serveTokenIndex < 0) throw new Error(`Systemd service ${unit} ExecStart must invoke OpenChamber serve`);
  const prefix = execTokens.slice(0, serveTokenIndex).map((token) => token.value);
  if (/^[-@:+!|]/.test(prefix[0] || '')) {
    throw new Error(`Systemd service ${unit} uses an unsupported ExecStart control prefix`);
  }
  const directExecutable = prefix.length === 1 ? path.basename(prefix[0]).toLowerCase() : '';
  const directLaunch = directExecutable === 'openchamber' || directExecutable === 'openchamber-managed';
  const nodeLaunch = prefix.length === 2
    && ['node', 'nodejs'].includes(path.basename(prefix[0]).toLowerCase())
    && path.basename(prefix[1]).toLowerCase() === 'cli.js'
    && prefix[1].toLowerCase().includes('openchamber');
  if (!directLaunch && !nodeLaunch) {
    throw new Error(`Systemd service ${unit} uses an unsupported ExecStart prefix; remove inline env, Node flags, or custom wrappers before enabling in-app updates`);
  }
  const preservedArguments = originalExecStart.slice(execTokens[serveTokenIndex].start);
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
    if (launcherExisted) atomicWriteFileSync(launcherPath, originalLauncher, launcherMode);
    else {
      try { fs.unlinkSync(launcherPath); } catch {}
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

function runStartupCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout ?? SYSTEMD_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function getStartupStatus() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    return { supported: false, platform: paths.platform, enabled: false, servicePath: null };
  }
  if (paths.platform === 'windows') {
    const result = runStartupCommand('schtasks.exe', ['/Query', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
    return { supported: true, platform: paths.platform, enabled: result.status === 0, active: null, servicePath: paths.servicePath };
  }
  if (paths.platform === 'linux') {
    const enabledResult = runStartupCommand('systemctl', ['--user', 'is-enabled', 'openchamber.service'], { allowFailure: true });
    const activeResult = runStartupCommand('systemctl', ['--user', 'is-active', 'openchamber.service'], { allowFailure: true });
    const activeState = (activeResult.stdout || '').trim() || 'inactive';
    return {
      supported: true,
      platform: paths.platform,
      enabled: enabledResult.status === 0 || fs.existsSync(paths.servicePath),
      active: activeState === 'active',
      activeState,
      servicePath: paths.servicePath,
    };
  }
  return {
    supported: true,
    platform: paths.platform,
    enabled: fs.existsSync(paths.servicePath),
    active: null,
    servicePath: paths.servicePath,
  };
}

function enableStartupService(options = {}) {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    removeStartupEnvFile();
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(os.homedir(), 'Library', 'Logs', 'OpenChamber'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildMacosLaunchAgent(options), { mode: 0o600 });
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    runStartupCommand('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.servicePath]);
    runStartupCommand('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${STARTUP_SERVICE_ID}`], { allowFailure: true });
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    writeStartupEnvFile(options, { quoteValue: systemdEnvFileQuote });
    const launcherPath = writeManagedLauncher(options);
    fs.mkdirSync(path.dirname(paths.servicePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.servicePath, buildSystemdUserService({ ...options, launcherPath }), { mode: 0o600 });
    runStartupCommand('systemctl', ['--user', 'daemon-reload']);
    runStartupCommand('systemctl', ['--user', 'enable', '--now', 'openchamber.service']);
    return getStartupStatus();
  }

  writeStartupEnvFile(options);
  const wrapperPath = writeWindowsStartupWrapper(options);
  const taskCommand = buildWindowsStartupTaskCommand(wrapperPath);
  runStartupCommand('schtasks.exe', [
    '/Create',
    '/TN', STARTUP_SERVICE_ID,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
    '/TR', taskCommand,
  ]);
  runStartupCommand('schtasks.exe', ['/Run', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  return getStartupStatus();
}

function disableStartupService() {
  const paths = getStartupServicePaths();
  if (!paths.servicePath) {
    throw new TunnelCliError(`Startup integration is not supported on ${paths.platform}.`, EXIT_CODE.USAGE_ERROR);
  }

  if (paths.platform === 'macos') {
    runStartupCommand('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, paths.servicePath], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {}
    return getStartupStatus();
  }

  if (paths.platform === 'linux') {
    runStartupCommand('systemctl', ['--user', 'disable', '--now', 'openchamber.service'], { allowFailure: true });
    try { fs.unlinkSync(paths.servicePath); } catch {}
    runStartupCommand('systemctl', ['--user', 'daemon-reload'], { allowFailure: true });
    return getStartupStatus();
  }

  runStartupCommand('schtasks.exe', ['/End', '/TN', STARTUP_SERVICE_ID], { allowFailure: true });
  runStartupCommand('schtasks.exe', ['/Delete', '/TN', STARTUP_SERVICE_ID, '/F'], { allowFailure: true });
  try { fs.unlinkSync(getWindowsStartupWrapperPath()); } catch {}
  removeStartupEnvFile();
  return getStartupStatus();
}


export {
  buildManagedLauncher,
  buildSystemdUserService,
  migrateSystemdServiceToManagedLauncher,
  getStartupStatus,
  enableStartupService,
  disableStartupService,
  buildWindowsStartupTaskCommand,
};
