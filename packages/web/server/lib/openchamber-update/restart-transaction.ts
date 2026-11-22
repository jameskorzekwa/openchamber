import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import properLockfile from 'proper-lockfile';
import type { FileHandle } from 'node:fs/promises';
import type { JsonValue } from '../shared/json-values.js';

export interface ProcessIdentity { pid: number; startedAt: string }
export interface SystemdRollback {
  unit: string;
  servicePath: string;
  serviceMode: number;
  originalService: string;
  launcherPath: string;
  launcherExisted: boolean;
  launcherMode: number;
  originalLauncher: string | null;
}
export interface RestartContext {
  installRoot: string;
  statusPath: string;
  targetVersion: string;
  targetRevision: string;
  targetDirectory: string;
  previousVersion: string;
  previousRevision: string;
  previousDirectory: string;
}
interface TransactionFields extends RestartContext {
  schemaVersion: number;
  phase: string;
  healthUrl: string;
  transactionId: string;
  attestationSecret: string;
  origin: ProcessIdentity;
}
export type RestartTransaction = TransactionFields & (
  { manager: 'systemd'; systemd: SystemdRollback } |
  { manager: 'supervisor'; systemd: null }
);
interface Attestation extends ProcessIdentity {
  transactionId: string;
  challenge: string;
  runningPath: string;
  selectedPath: string;
  version: string;
  revision: string;
  healthy: boolean;
}
type VerifiedIdentity = ProcessIdentity & { healthy: boolean };
export interface RestartOptions {
  systemdRoot?: string | undefined;
  leaseStaleMs?: number;
  leaseUpdateMs?: number;
  expectedTransactionId?: string;
  fetchImpl?: typeof fetch;
  spawnSyncImpl?: typeof spawnSync;
  delayImpl?: (milliseconds: number) => Promise<void>;
  pollMs?: number;
  targetTimeoutMs?: number;
  rollbackTimeoutMs?: number;
  supervisorConfirmationTimeoutMs?: number;
  recoveryWindowMs?: number;
  recoveryPollMs?: number;
  assertOwned?: () => Promise<void>;
  beforeJournalCleanup?: ((transaction: RestartTransaction) => Promise<void>) | undefined;
}
interface RestartRuntime extends RestartOptions {
  fetchImpl: typeof fetch;
  spawnSyncImpl: typeof spawnSync;
  wait: (milliseconds: number) => Promise<void>;
  pollMs: number;
  targetTimeoutMs: number;
  rollbackTimeoutMs: number;
  supervisorConfirmationTimeoutMs: number;
  assertOwned: () => Promise<void>;
}
const hasErrorCode = (value: unknown): value is { code: string } =>
  value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string';

const TRANSACTION_SCHEMA = 3;
const TRANSACTION_NAME = 'restart-transaction.json';
const STATUS_NAME = 'update-status.json';
const UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-j2k\.\d+)?$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_ROLLBACK_FILE_BYTES = 1024 * 1024;
const SYSTEM_COMMAND_TIMEOUT_MS = 10_000;
const LEASE_STALE_MS = 15_000;
const MAX_TERMINATION_MARKERS = 256;
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const hasExactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> => value?.constructor === Object
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function signPayload(secret: string, purpose: string, fields: string[]) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update([purpose, ...fields].join('\0')).digest('hex');
}

function safeEqualHex(left: string, right: string) {
  if (!TOKEN_PATTERN.test(left || '') || !TOKEN_PATTERN.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function syncDirectory(directory: string) {
  const handle = await fsp.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileDurably(filePath: string, content: string | Buffer, mode: number) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fsp.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, filePath);
  await fsp.chmod(filePath, mode);
  await syncDirectory(directory);
}

async function selectRelease(currentLink: string, targetDirectory: string) {
  const temporary = `${currentLink}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.symlink(targetDirectory, temporary);
  await fsp.rename(temporary, currentLink);
  await syncDirectory(path.dirname(currentLink));
}

function decodeRollbackFile(value: string | null, label: string) {
  if (value === null || value.constructor !== String || value.length === 0 || value.length > Math.ceil(MAX_ROLLBACK_FILE_BYTES / 3) * 4 || !BASE64_PATTERN.test(value)) {
    throw new Error(`Invalid restart transaction ${label}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length > MAX_ROLLBACK_FILE_BYTES || decoded.toString('base64') !== value) throw new Error(`Invalid restart transaction ${label}`);
  return decoded;
}

function validateMode(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0o777) throw new Error(`Invalid restart transaction ${label}`);
}

async function validateReleaseIdentity(directory: string, version: string, revision: string, allowedRoot: string, label: string) {
  const resolved = path.resolve(directory);
  if (!isPathInside(allowedRoot, resolved)) throw new Error(`Restart transaction ${label} directory escapes its allowed root`);
  const canonical = await fsp.realpath(resolved);
  if (!isPathInside(allowedRoot, canonical)) throw new Error(`Restart transaction ${label} directory resolves outside its allowed root`);
  const packageJson = JSON.parse(await fsp.readFile(path.join(canonical, 'package.json'), 'utf8'));
  const buildRevision = JSON.parse(await fsp.readFile(path.join(canonical, 'dist', 'build-revision.json'), 'utf8'));
  if (packageJson?.name !== '@openchamber/web' || packageJson.version !== version || buildRevision?.revision !== revision) {
    throw new Error(`Restart transaction ${label} identity does not match its package`);
  }
  return canonical;
}

function hasTransactionFields(raw: unknown): raw is RestartTransaction {
  if (!hasExactKeys(raw, [
    'schemaVersion', 'manager', 'phase', 'installRoot', 'targetVersion', 'targetRevision', 'targetDirectory',
    'previousVersion', 'previousRevision', 'previousDirectory', 'healthUrl', 'statusPath', 'transactionId', 'attestationSecret', 'origin', 'systemd',
  ])) return false;
  if (raw.schemaVersion !== TRANSACTION_SCHEMA || !['systemd', 'supervisor'].includes(String(raw.manager))
    || !['prepared', 'target', 'rollback', 'failed'].includes(String(raw.phase))) return false;
  for (const field of ['installRoot', 'targetVersion', 'targetRevision', 'targetDirectory', 'previousVersion', 'previousRevision', 'previousDirectory', 'healthUrl', 'statusPath', 'transactionId', 'attestationSecret']) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) return false;
  }
  if (!hasExactKeys(raw.origin, ['pid', 'startedAt']) || typeof raw.origin.pid !== 'number' || typeof raw.origin.startedAt !== 'string') return false;
  if (raw.manager === 'supervisor') return raw.systemd === null;
  if (!hasExactKeys(raw.systemd, ['unit', 'servicePath', 'serviceMode', 'originalService', 'launcherPath', 'launcherExisted', 'launcherMode', 'originalLauncher'])) return false;
  return typeof raw.systemd.unit === 'string' && typeof raw.systemd.servicePath === 'string'
    && typeof raw.systemd.serviceMode === 'number' && typeof raw.systemd.originalService === 'string'
    && typeof raw.systemd.launcherPath === 'string' && typeof raw.systemd.launcherExisted === 'boolean'
    && typeof raw.systemd.launcherMode === 'number'
    && (raw.systemd.originalLauncher === null || typeof raw.systemd.originalLauncher === 'string');
}

async function validateTransaction(transactionPath: string, input: RestartTransaction, options: RestartOptions = {}): Promise<RestartTransaction> {
  if (!hasTransactionFields(input)) throw new Error('Invalid restart transaction schema');
  const raw = input;
  const commonKeys = [
    'schemaVersion', 'manager', 'phase', 'installRoot', 'targetVersion', 'targetRevision', 'targetDirectory',
    'previousVersion', 'previousRevision', 'previousDirectory', 'healthUrl', 'statusPath', 'transactionId', 'attestationSecret', 'origin', 'systemd',
  ];
  if (!hasExactKeys(raw, commonKeys) || raw.schemaVersion !== TRANSACTION_SCHEMA) throw new Error('Invalid restart transaction schema');
  if (!['systemd', 'supervisor'].includes(raw.manager) || !['prepared', 'target', 'rollback', 'failed'].includes(raw.phase)) throw new Error('Invalid restart transaction manager or phase');
  for (const field of ['installRoot', 'targetVersion', 'targetRevision', 'targetDirectory', 'previousVersion', 'previousRevision', 'previousDirectory', 'healthUrl', 'statusPath', 'transactionId', 'attestationSecret'] as const) {
    if (raw[field]?.constructor !== String || raw[field].length === 0) throw new Error(`Invalid restart transaction ${field}`);
  }
  if (!VERSION_PATTERN.test(raw.targetVersion) || !VERSION_PATTERN.test(raw.previousVersion)) throw new Error('Invalid restart transaction version');
  if (!REVISION_PATTERN.test(raw.targetRevision) || !BUILD_REVISION_PATTERN.test(raw.previousRevision)) throw new Error('Invalid restart transaction revision');
  if (!TRANSACTION_ID_PATTERN.test(raw.transactionId) || !TOKEN_PATTERN.test(raw.attestationSecret)) throw new Error('Invalid restart transaction identity');
  const installRoot = path.resolve(raw.installRoot);
  if (path.resolve(transactionPath) !== path.join(installRoot, TRANSACTION_NAME)) throw new Error('Restart transaction path does not match its install root');
  if (path.resolve(raw.statusPath) !== path.join(installRoot, STATUS_NAME)) throw new Error('Restart transaction status path is invalid');
  const targetRoot = path.join(installRoot, 'releases');
  const targetDirectory = await validateReleaseIdentity(raw.targetDirectory, raw.targetVersion, raw.targetRevision, targetRoot, 'target');
  if (targetDirectory !== path.join(targetRoot, `${raw.targetVersion}-${raw.targetRevision.slice(0, 12)}`)) throw new Error('Restart transaction target path is not canonical');
  const previousDirectory = await validateReleaseIdentity(raw.previousDirectory, raw.previousVersion, raw.previousRevision, installRoot, 'previous');
  if (!isPathInside(path.join(installRoot, 'releases'), previousDirectory) && !isPathInside(path.join(installRoot, 'archives'), previousDirectory)) {
    throw new Error('Restart transaction previous path is not a release or archive');
  }
  const healthUrl = new URL(raw.healthUrl);
  if (healthUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(healthUrl.hostname) || healthUrl.pathname !== '/health' || healthUrl.username || healthUrl.password) {
    throw new Error('Restart transaction health URL is invalid');
  }
  if (!hasExactKeys(raw.origin, ['pid', 'startedAt']) || !Number.isInteger(raw.origin.pid) || raw.origin.pid <= 0 || raw.origin.startedAt?.constructor !== String || !Number.isFinite(Date.parse(raw.origin.startedAt))) {
    throw new Error('Invalid restart transaction origin');
  }
  if (raw.manager === 'supervisor') {
    if (raw.systemd !== null) throw new Error('Supervisor restart transaction must not contain systemd data');
  } else {
    if (!hasExactKeys(raw.systemd, ['unit', 'servicePath', 'serviceMode', 'originalService', 'launcherPath', 'launcherExisted', 'launcherMode', 'originalLauncher'])) {
      throw new Error('Restart transaction is missing exact systemd rollback data');
    }
    if (!UNIT_PATTERN.test(raw.systemd.unit)) throw new Error('Invalid restart transaction systemd unit');
    const systemdRoot = path.resolve(options.systemdRoot || path.join(os.homedir(), '.config', 'systemd', 'user'));
    if (!isPathInside(systemdRoot, path.resolve(raw.systemd.servicePath)) || path.extname(raw.systemd.servicePath) !== '.service') throw new Error('Restart transaction service path is invalid');
    if (path.resolve(raw.systemd.launcherPath) !== path.join(installRoot, 'bin', 'openchamber-managed')) throw new Error('Restart transaction launcher path is invalid');
    const [serviceStat, launcherStat, canonicalService] = await Promise.all([
      fsp.lstat(raw.systemd.servicePath),
      fsp.lstat(raw.systemd.launcherPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)),
      fsp.realpath(raw.systemd.servicePath),
    ]);
    if (!serviceStat.isFile() || serviceStat.isSymbolicLink() || !isPathInside(systemdRoot, canonicalService)) throw new Error('Restart transaction service path is unsafe');
    if (launcherStat && (!launcherStat.isFile() || launcherStat.isSymbolicLink())) throw new Error('Restart transaction launcher path is unsafe');
    validateMode(raw.systemd.serviceMode, 'serviceMode');
    validateMode(raw.systemd.launcherMode, 'launcherMode');
    decodeRollbackFile(raw.systemd.originalService, 'originalService');
    if (raw.systemd.launcherExisted === true) {
      if (!launcherStat) throw new Error('Restart transaction existing launcher is missing');
      decodeRollbackFile(raw.systemd.originalLauncher, 'originalLauncher');
    }
    else if (raw.systemd.launcherExisted !== false || raw.systemd.originalLauncher !== null) throw new Error('Restart transaction launcher existence is inconsistent');
  }
  return { ...raw, installRoot, targetDirectory, previousDirectory, healthUrl: healthUrl.toString() };
}

async function readValidatedTransaction(transactionPath: string, options: RestartOptions) {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(transactionPath, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'ENOENT') throw error;
    throw new Error('Restart transaction is missing or malformed');
  }
  if (!hasTransactionFields(raw)) throw new Error('Invalid restart transaction schema');
  return validateTransaction(transactionPath, raw, options);
}

async function persistStatus(transaction: RestartTransaction, state: string, error: string | null = null) {
  await writeFileDurably(transaction.statusPath, `${JSON.stringify({
    schemaVersion: 1,
    state,
    currentVersion: state === 'installed' ? transaction.targetVersion : transaction.previousVersion,
    targetVersion: transaction.targetVersion,
    previousVersion: transaction.previousVersion,
    error,
    updatedAt: new Date().toISOString(),
  })}\n`, 0o600);
}

async function persistTransaction(transactionPath: string, transaction: RestartTransaction) {
  await writeFileDurably(transactionPath, `${JSON.stringify(transaction)}\n`, 0o600);
}

async function cleanupTerminationMarkers(transaction: RestartTransaction) {
  const parent = path.join(transaction.installRoot, 'restart-termination');
  const capabilityRoot = path.join(parent, transaction.transactionId);
  const parentStat = await fsp.lstat(parent).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!parentStat) return;
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Restart termination marker parent is unsafe');
  const rootStat = await fsp.lstat(capabilityRoot).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Restart termination marker directory is unsafe');
  const entries = await fsp.readdir(capabilityRoot, { withFileTypes: true });
  if (entries.length > MAX_TERMINATION_MARKERS) throw new Error('Restart termination marker cleanup exceeds its entry limit');
  for (const entry of entries) {
    if (!entry.isFile() || !TOKEN_PATTERN.test(entry.name)) throw new Error('Restart termination marker directory contains an unsafe entry');
    await fsp.unlink(path.join(capabilityRoot, entry.name));
  }
  await fsp.rmdir(capabilityRoot).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  await fsp.rmdir(parent).catch((error) => { if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error; });
}

async function ensureTerminationMarkerDirectory(transaction: RestartTransaction) {
  const parent = path.join(transaction.installRoot, 'restart-termination');
  const capabilityRoot = path.join(parent, transaction.transactionId);
  await fsp.mkdir(parent, { mode: 0o700 }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
  const parentStat = await fsp.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Restart termination marker parent is unsafe');
  await fsp.mkdir(capabilityRoot, { mode: 0o700 }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
  const rootStat = await fsp.lstat(capabilityRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Restart termination marker directory is unsafe');
  return capabilityRoot;
}

async function cleanupCurrentJournal(transactionPath: string, transaction: RestartTransaction, options: RestartOptions = {}) {
  await options.assertOwned?.();
  await options.beforeJournalCleanup?.(transaction);
  await options.assertOwned?.();
  const current = await readValidatedTransaction(transactionPath, options);
  if (current.transactionId !== transaction.transactionId) return false;
  await cleanupTerminationMarkers(transaction);
  await options.assertOwned?.();
  const revalidated = await readValidatedTransaction(transactionPath, options);
  if (revalidated.transactionId !== transaction.transactionId) return false;
  const tombstone = `${transactionPath}.completed-${transaction.transactionId}`;
  await fsp.rename(transactionPath, tombstone);
  await syncDirectory(transaction.installRoot);
  await fsp.rm(tombstone, { force: true });
  await syncDirectory(transaction.installRoot);
  return true;
}

function systemctl(transaction: RestartTransaction, spawnSyncImpl: typeof spawnSync, command: string) {
  if (transaction.manager !== 'systemd') throw new Error('Systemd command requires a systemd transaction');
  const args = command === 'daemon-reload' ? ['--user', command] : ['--user', command, transaction.systemd.unit];
  const result = spawnSyncImpl('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: SYSTEM_COMMAND_TIMEOUT_MS });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `systemctl ${command} failed`);
}

function attestationFields(attestation: Attestation) {
  return [
    attestation.transactionId,
    attestation.challenge,
    String(attestation.pid),
    attestation.startedAt,
    attestation.runningPath,
    attestation.selectedPath,
    attestation.version,
    attestation.revision,
    attestation.healthy ? '1' : '0',
  ];
}

export async function createRestartAttestation({ transactionPath, transactionId, challenge, currentVersion, currentRevision, runtimePath, pid, startedAt, healthy, options = {} }: {
  transactionPath: string; transactionId: string; challenge: string; currentVersion: string; currentRevision: string;
  runtimePath: string | null; pid: number; startedAt: string; healthy: boolean; options?: RestartOptions;
}) {
  if (!TRANSACTION_ID_PATTERN.test(transactionId || '') || !TOKEN_PATTERN.test(challenge || '') || !Number.isInteger(pid) || pid <= 0 || startedAt?.constructor !== String || healthy?.constructor !== Boolean) {
    throw new Error('Invalid restart attestation request');
  }
  const transaction = await readValidatedTransaction(transactionPath, options);
  if (transaction.transactionId !== transactionId) throw new Error('Restart transaction ID does not match');
  const isTarget = currentVersion === transaction.targetVersion && currentRevision === transaction.targetRevision;
  const isPrevious = currentVersion === transaction.previousVersion && currentRevision === transaction.previousRevision;
  if (!isTarget && !isPrevious) throw new Error('Running release identity does not match the restart transaction');
  const runningPath = isTarget ? transaction.targetDirectory : transaction.previousDirectory;
  if (runtimePath === null || await fsp.realpath(runtimePath) !== runningPath) throw new Error('Runtime package path does not match the restart transaction release');
  const selectedPath = await fsp.realpath(path.join(transaction.installRoot, 'current'));
  if (![transaction.targetDirectory, transaction.previousDirectory].includes(selectedPath)) throw new Error('Selected release is outside the restart transaction');
  const attestation = { transactionId, challenge, pid, startedAt, runningPath, selectedPath, version: currentVersion, revision: currentRevision, healthy };
  return { ...attestation, mac: signPayload(transaction.attestationSecret, 'attest', attestationFields(attestation)) };
}

export async function consumeSupervisorTermination({ transactionPath, transactionId, pid, startedAt, nonce, authorization, currentVersion, currentRevision, actualPid, actualStartedAt, options = {} }: {
  transactionPath: string; transactionId: string; pid: number; startedAt: string; nonce: string; authorization: string;
  currentVersion: string; currentRevision: string; actualPid: number; actualStartedAt: string; options?: RestartOptions;
}) {
  if (!TRANSACTION_ID_PATTERN.test(transactionId || '') || !Number.isInteger(pid) || pid <= 0 || startedAt?.constructor !== String || !TOKEN_PATTERN.test(nonce || '') || !TOKEN_PATTERN.test(authorization || '')) return false;
  const transaction = await readValidatedTransaction(transactionPath, options);
  if (pid !== actualPid || startedAt !== actualStartedAt) return false;
  if (transaction.transactionId !== transactionId || transaction.manager !== 'supervisor' || transaction.phase !== 'rollback') return false;
  if (transaction.targetVersion !== currentVersion || transaction.targetRevision !== currentRevision) return false;
  const selectedPath = await fsp.realpath(path.join(transaction.installRoot, 'current'));
  if (selectedPath !== transaction.previousDirectory) return false;
  const expected = signPayload(transaction.attestationSecret, 'terminate', terminationFields(transactionId, { pid, startedAt }, nonce));
  if (!safeEqualHex(authorization, expected)) return false;
  const capabilityRoot = await ensureTerminationMarkerDirectory(transaction);
  const identityHash = crypto.createHash('sha256').update(`${pid}\0${startedAt}`).digest('hex');
  const capabilityPath = path.join(capabilityRoot, identityHash);
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(capabilityPath, 'wx', 0o600);
    await handle.writeFile(`${nonce}\n`);
    await handle.sync();
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await handle?.close();
  }
  await syncDirectory(capabilityRoot);
  return true;
}

function isAttestation(raw: unknown): raw is Attestation & { mac: string } {
  if (!hasExactKeys(raw, ['transactionId', 'challenge', 'pid', 'startedAt', 'runningPath', 'selectedPath', 'version', 'revision', 'healthy', 'mac'])) return false;
  return typeof raw.transactionId === 'string' && typeof raw.challenge === 'string' && typeof raw.pid === 'number'
    && typeof raw.startedAt === 'string' && typeof raw.runningPath === 'string' && typeof raw.selectedPath === 'string'
    && typeof raw.version === 'string' && typeof raw.revision === 'string' && typeof raw.healthy === 'boolean'
    && typeof raw.mac === 'string';
}
export function verifyRestartAttestation(transaction: RestartTransaction, input: JsonValue, challenge: string, version: string, revision: string) {
  if (!isAttestation(input)) return null;
  const raw = input;
  if (!hasExactKeys(raw, ['transactionId', 'challenge', 'pid', 'startedAt', 'runningPath', 'selectedPath', 'version', 'revision', 'healthy', 'mac'])) return null;
  if (raw.transactionId !== transaction.transactionId || raw.challenge !== challenge || raw.version !== version || raw.revision !== revision) return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0 || raw.startedAt?.constructor !== String || raw.healthy?.constructor !== Boolean) return null;
  const expectedRunningPath = version === transaction.targetVersion && revision === transaction.targetRevision
    ? transaction.targetDirectory
    : transaction.previousDirectory;
  const expectedSelectedPath = transaction.phase === 'rollback' ? transaction.previousDirectory : transaction.targetDirectory;
  if (raw.runningPath !== expectedRunningPath || raw.selectedPath !== expectedSelectedPath) return null;
  const expectedMac = signPayload(transaction.attestationSecret, 'attest', attestationFields(raw));
  if (!safeEqualHex(raw.mac, expectedMac)) return null;
  return { pid: raw.pid, startedAt: raw.startedAt, healthy: raw.healthy };
}

async function probeHealth(transaction: RestartTransaction, version: string, revision: string, fetchImpl: typeof fetch, timeoutMs: number, pollMs: number, wait: (milliseconds: number) => Promise<void>) {
  const deadline = Date.now() + timeoutMs;
  let lastIdentity: VerifiedIdentity | null = null;
  while (Date.now() < deadline) {
    try {
      const challenge = crypto.randomBytes(32).toString('hex');
      const url = new URL('/health/update-attestation', transaction.healthUrl);
      const response = await fetchImpl(url, {
        headers: {
          'x-openchamber-transaction-id': transaction.transactionId,
          'x-openchamber-attestation-challenge': challenge,
        },
        signal: AbortSignal.timeout(Math.min(pollMs, 2_000)),
      });
      const body = await response.json();
      const identity = response.ok ? verifyRestartAttestation(transaction, body, challenge, version, revision) : null;
      if (identity) {
        lastIdentity = identity;
        if (identity.healthy) return { healthy: true, identity };
      }
    } catch {
      void 0;
    }
    await wait(pollMs);
  }
  return { healthy: false, identity: lastIdentity };
}

function terminationFields(transactionId: string, identity: ProcessIdentity, nonce: string) {
  return [transactionId, String(identity.pid), identity.startedAt, nonce];
}

async function requestSupervisorRestart(transaction: RestartTransaction, identity: ProcessIdentity | null, fetchImpl: typeof fetch) {
  if (!identity) throw new Error('Updated process did not provide an authenticated identity for rollback');
  const url = new URL('/health/restart-for-update', transaction.healthUrl);
  const nonce = crypto.randomBytes(32).toString('hex');
  const authorization = signPayload(transaction.attestationSecret, 'terminate', terminationFields(transaction.transactionId, identity, nonce));
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'x-openchamber-transaction-id': transaction.transactionId,
      'x-openchamber-process-pid': String(identity.pid),
      'x-openchamber-process-started-at': identity.startedAt,
      'x-openchamber-termination-nonce': nonce,
      'x-openchamber-termination-authorization': authorization,
    },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Updated process refused rollback restart with HTTP ${response.status}`);
}

async function rollback(transactionPath: string, transaction: RestartTransaction, options: RestartRuntime, cause: string, targetIdentity: VerifiedIdentity | null = null) {
  await options.assertOwned();
  const rollbackTransaction = { ...transaction, phase: 'rollback' };
  await persistTransaction(transactionPath, rollbackTransaction);
  await options.assertOwned();
  await persistStatus(transaction, 'restarting', `Target failed health verification; rollback in progress: ${cause}`);
  await options.assertOwned();
  await selectRelease(path.join(transaction.installRoot, 'current'), transaction.previousDirectory);
  if (transaction.manager === 'systemd') {
    const systemd = transaction.systemd;
    await options.assertOwned();
    await writeFileDurably(systemd.servicePath, decodeRollbackFile(systemd.originalService, 'originalService'), systemd.serviceMode);
    await options.assertOwned();
    if (systemd.launcherExisted) await writeFileDurably(systemd.launcherPath, decodeRollbackFile(systemd.originalLauncher, 'originalLauncher'), systemd.launcherMode);
    else {
      await fsp.rm(systemd.launcherPath, { force: true });
      await syncDirectory(path.dirname(systemd.launcherPath));
    }
    await options.assertOwned();
    systemctl(transaction, options.spawnSyncImpl, 'daemon-reload');
    await options.assertOwned();
    systemctl(transaction, options.spawnSyncImpl, 'restart');
  } else {
    const alreadyPrevious = await probeHealth(rollbackTransaction, transaction.previousVersion, transaction.previousRevision, options.fetchImpl, options.supervisorConfirmationTimeoutMs, options.pollMs, options.wait);
    if (alreadyPrevious.healthy) {
      await options.assertOwned();
      await persistStatus(transaction, 'rollback', cause);
      return cleanupCurrentJournal(transactionPath, rollbackTransaction, options);
    }
    await options.assertOwned();
    let identity = targetIdentity;
    for (let attempt = 0; attempt < 3 && identity; attempt += 1) {
      const requestedIdentity = identity;
      try {
        await requestSupervisorRestart(rollbackTransaction, requestedIdentity, options.fetchImpl);
        identity = null;
        break;
      } catch (error) {
        const target = await probeHealth(rollbackTransaction, transaction.targetVersion, transaction.targetRevision, options.fetchImpl, options.supervisorConfirmationTimeoutMs, options.pollMs, options.wait);
        if (!target.identity) {
          identity = null;
          break;
        }
        if (target.identity.pid === requestedIdentity.pid && target.identity.startedAt === requestedIdentity.startedAt) throw error;
        identity = target.identity;
      }
    }
  }
  const previous = await probeHealth(rollbackTransaction, transaction.previousVersion, transaction.previousRevision, options.fetchImpl, options.rollbackTimeoutMs, options.pollMs, options.wait);
  if (!previous.healthy) throw new Error(`Previous OpenChamber ${transaction.previousVersion} did not recover`);
  await options.assertOwned();
  await persistStatus(transaction, 'rollback', cause);
  return cleanupCurrentJournal(transactionPath, rollbackTransaction, options);
}

export async function writeRestartTransaction(transactionPath: string, transaction: RestartTransaction, options: RestartOptions = {}) {
  const validated = await validateTransaction(transactionPath, transaction, options);
  await persistTransaction(transactionPath, validated);
}

export async function activateRestartTransaction(transactionPath: string, transactionId: string, options: RestartOptions = {}) {
  const transaction = await readValidatedTransaction(transactionPath, options);
  if (transaction.transactionId !== transactionId || transaction.phase !== 'prepared') throw new Error('Prepared restart transaction does not match activation request');
  await persistTransaction(transactionPath, { ...transaction, phase: 'target' });
}

export async function cancelRestartTransaction(transactionPath: string, transactionId: string, options: RestartOptions = {}) {
  const initial = await readValidatedTransaction(transactionPath, options);
  if (initial.transactionId !== transactionId) return false;
  const leasePath = `${transactionPath}.lease`;
  const ownerPath = `${transactionPath}.owner`;
  const ownerToken = crypto.randomBytes(32).toString('hex');
  let release;
  try {
    release = await properLockfile.lock(initial.installRoot, {
      realpath: false,
      lockfilePath: leasePath,
      stale: options.leaseStaleMs ?? LEASE_STALE_MS,
      update: options.leaseUpdateMs ?? 5_000,
      retries: 0,
    });
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'ELOCKED') return false;
    throw error;
  }
  await writeFileDurably(ownerPath, `${ownerToken}\n`, 0o600);
  const assertOwned = async () => {
    const owner = await fsp.readFile(ownerPath, 'utf8').catch(() => '');
    if (owner.trim() !== ownerToken) throw new Error('Restart transaction cancellation lost ownership');
  };
  try {
    const transaction = await readValidatedTransaction(transactionPath, options);
    if (transaction.transactionId !== transactionId) return false;
    const selectedPath = await fsp.realpath(path.join(transaction.installRoot, 'current'));
    if (selectedPath !== transaction.previousDirectory) return false;
    if (transaction.manager === 'systemd') {
      const systemd = transaction.systemd;
      await assertOwned();
      await writeFileDurably(systemd.servicePath, decodeRollbackFile(systemd.originalService, 'originalService'), systemd.serviceMode);
      await assertOwned();
      if (systemd.launcherExisted) await writeFileDurably(systemd.launcherPath, decodeRollbackFile(systemd.originalLauncher, 'originalLauncher'), systemd.launcherMode);
      else {
        await fsp.rm(systemd.launcherPath, { force: true });
        await syncDirectory(path.dirname(systemd.launcherPath));
      }
      await assertOwned();
      systemctl(transaction, options.spawnSyncImpl || spawnSync, 'daemon-reload');
    }
    return cleanupCurrentJournal(transactionPath, transaction, { ...options, assertOwned });
  } finally {
    const owner = await fsp.readFile(ownerPath, 'utf8').catch(() => '');
    if (owner.trim() === ownerToken) await fsp.rm(ownerPath, { force: true });
    await release().catch(() => {});
    await syncDirectory(initial.installRoot);
  }
}

export async function runRestartTransaction(transactionPath: string, options: RestartOptions = {}) {
  const initial = await readValidatedTransaction(transactionPath, options);
  if (options.expectedTransactionId && initial.transactionId !== options.expectedTransactionId) return { owned: false, state: 'superseded' };
  const leasePath = `${transactionPath}.lease`;
  const ownerPath = `${transactionPath}.owner`;
  const ownerToken = crypto.randomBytes(32).toString('hex');
  let release;
  try {
    release = await properLockfile.lock(initial.installRoot, {
      realpath: false,
      lockfilePath: leasePath,
      stale: options.leaseStaleMs ?? LEASE_STALE_MS,
      update: options.leaseUpdateMs ?? 5_000,
      retries: 0,
    });
  } catch (error) {
    if (hasErrorCode(error) && error.code === 'ELOCKED') return { owned: false };
    throw error;
  }
  await writeFileDurably(ownerPath, `${ownerToken}\n`, 0o600);
  const assertOwned = async () => {
    const owner = await fsp.readFile(ownerPath, 'utf8').catch(() => '');
    if (owner.trim() !== ownerToken) throw new Error('Restart transaction helper lost ownership to a fallback');
  };
  const runtime = {
    fetchImpl: options.fetchImpl || fetch,
    spawnSyncImpl: options.spawnSyncImpl || spawnSync,
    wait: options.delayImpl || delay,
    pollMs: options.pollMs ?? 500,
    targetTimeoutMs: options.targetTimeoutMs ?? 45_000,
    rollbackTimeoutMs: options.rollbackTimeoutMs ?? 45_000,
    supervisorConfirmationTimeoutMs: options.supervisorConfirmationTimeoutMs ?? 1_000,
    assertOwned,
    beforeJournalCleanup: options.beforeJournalCleanup,
    systemdRoot: options.systemdRoot,
  };
  try {
    let transaction = await readValidatedTransaction(transactionPath, options);
    if (options.expectedTransactionId && transaction.transactionId !== options.expectedTransactionId) return { owned: true, state: 'superseded' };
    if (transaction.phase === 'failed') return { owned: true, state: 'failed' };
    if (transaction.phase === 'prepared') {
      const selectedPath = await fsp.realpath(path.join(transaction.installRoot, 'current'));
      if (selectedPath === transaction.previousDirectory) {
        if (transaction.manager === 'systemd') {
          const systemd = transaction.systemd;
          await assertOwned();
          await writeFileDurably(systemd.servicePath, decodeRollbackFile(systemd.originalService, 'originalService'), systemd.serviceMode);
          if (systemd.launcherExisted) await writeFileDurably(systemd.launcherPath, decodeRollbackFile(systemd.originalLauncher, 'originalLauncher'), systemd.launcherMode);
          else await fsp.rm(systemd.launcherPath, { force: true });
          systemctl(transaction, runtime.spawnSyncImpl, 'daemon-reload');
        }
        await persistStatus(transaction, 'failed', 'OpenChamber update stopped after journal preparation and before release selection');
        if (!await cleanupCurrentJournal(transactionPath, transaction, runtime)) return { owned: true, state: 'superseded' };
        return { owned: true, state: 'failed' };
      }
      if (selectedPath !== transaction.targetDirectory) throw new Error('Prepared restart transaction selection is neither target nor previous release');
      transaction = { ...transaction, phase: 'target' };
      await assertOwned();
      await persistTransaction(transactionPath, transaction);
    }
    let targetError: string | null = null;
    if (transaction.manager === 'systemd' && transaction.phase === 'target') {
      try {
        await assertOwned();
        systemctl(transaction, runtime.spawnSyncImpl, 'restart');
      } catch (error) {
        targetError = error instanceof Error ? error.message : String(error);
      }
    }
    let targetIdentity: VerifiedIdentity | null = null;
    if (transaction.phase === 'target' && !targetError) {
      const target = await probeHealth(transaction, transaction.targetVersion, transaction.targetRevision, runtime.fetchImpl, runtime.targetTimeoutMs, runtime.pollMs, runtime.wait);
      targetIdentity = target.identity;
      if (target.healthy) {
        await assertOwned();
        await persistStatus(transaction, 'installed');
        if (!await cleanupCurrentJournal(transactionPath, transaction, runtime)) return { owned: true, state: 'superseded' };
        return { owned: true, state: 'installed' };
      }
    }
    const cause = transaction.phase === 'target'
      ? (targetError || `OpenChamber ${transaction.targetVersion} did not become healthy`)
      : 'Recovered an interrupted rollback transaction';
    const cleaned = await rollback(transactionPath, transaction, runtime, cause, targetIdentity);
    return { owned: true, state: cleaned ? 'rollback' : 'superseded' };
  } catch (error) {
    try {
      await assertOwned();
      const transaction = await readValidatedTransaction(transactionPath, options);
      await persistTransaction(transactionPath, { ...transaction, phase: 'failed' });
      await persistStatus(transaction, 'failed', `Automatic restart transaction failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      void 0;
    }
    throw error;
  } finally {
    const owner = await fsp.readFile(ownerPath, 'utf8').catch(() => '');
    if (owner.trim() === ownerToken) await fsp.rm(ownerPath, { force: true });
    await release().catch(() => {});
    await syncDirectory(initial.installRoot);
  }
}

export async function runRestartFallback(transactionPath: string, options: RestartOptions = {}) {
  const wait = options.delayImpl || delay;
  const deadline = Date.now() + (options.recoveryWindowMs ?? 180_000);
  while (Date.now() < deadline) {
    try {
      const result = await runRestartTransaction(transactionPath, options);
      if (result.state === 'superseded') return result;
      if (result.owned) return result;
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') return { owned: false, state: 'complete' };
      throw error;
    }
    await wait(options.recoveryPollMs ?? 5_000);
  }
  throw new Error('Restart transaction fallback could not acquire ownership before its deadline');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fallbackIndex = process.argv.indexOf('--fallback');
  const delayedFallbackIndex = process.argv.indexOf('--delayed-fallback');
  const transactionIdIndex = process.argv.indexOf('--transaction-id');
  const transactionPath = process.argv[fallbackIndex >= 0 ? fallbackIndex + 1 : delayedFallbackIndex >= 0 ? delayedFallbackIndex + 1 : 2];
  const expectedTransactionId = transactionIdIndex >= 0 ? process.argv[transactionIdIndex + 1] : null;
  if (!expectedTransactionId) throw new Error('Restart helper requires an expected transaction ID');
  if (!transactionPath) throw new Error('Restart helper requires a transaction path');
  const operation = delayedFallbackIndex >= 0
    ? delay(90_000).then(() => runRestartFallback(transactionPath, { expectedTransactionId }))
    : fallbackIndex >= 0
      ? runRestartFallback(transactionPath, { expectedTransactionId })
      : runRestartTransaction(transactionPath, { expectedTransactionId });
  operation.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
