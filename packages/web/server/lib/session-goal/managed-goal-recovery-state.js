import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STATE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9_-]{4,160}$/;

const defaultStateDirectory = () => path.join(os.homedir(), '.local', 'state', 'opencode', 'session-worktrees');

const statePath = (rootId, stateDirectory) => {
  if (!ID_PATTERN.test(rootId)) return null;
  return path.join(stateDirectory, `${rootId}.goal-recovery.json`);
};

const isText = (value) => String(value) === value;
const isRecord = (value) => value?.constructor === Object;
const nonEmpty = (value) => isText(value) && value.length > 0;

const validTarget = (target) => {
  if (!isRecord(target)) return false;
  if (!nonEmpty(target.sessionId) || !nonEmpty(target.messageId)) return false;
  return isText(target.taskPartId)
    && isText(target.taskCallId)
    && isText(target.taskChildSessionId)
    && isText(target.parentSessionId)
    && isText(target.parentMessageId);
};

const validState = (state, rootId) => {
  if (!isRecord(state) || state.version !== STATE_VERSION || state.rootId !== rootId) return false;
  if (!nonEmpty(state.goalId) || !nonEmpty(state.directory) || !validTarget(state.target)) return false;
  if (!Number.isInteger(state.attempts) || state.attempts < 0) return false;
  if (!Number.isFinite(state.nextAttemptAt) || !['aborting', 'delivery'].includes(state.phase)) return false;
  if (!isText(state.deliveryMessageId) || !isText(state.deliveryPrompt)) return false;
  if (!Number.isFinite(state.deliveryAttemptedAt)) return false;
  return Number.isInteger(state.deliveryAttempts) && state.deliveryAttempts >= 0;
};

export const readManagedGoalRecoveryState = async (rootId, options = {}) => {
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const target = statePath(rootId, stateDirectory);
  if (!target) return null;
  try {
    const state = JSON.parse(await readFile(target, 'utf8'));
    return validState(state, rootId) ? state : null;
  } catch {
    return null;
  }
};

export const writeManagedGoalRecoveryState = async (state, options = {}) => {
  if (!validState(state, state?.rootId)) throw new TypeError('invalid managed goal recovery state');
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const target = statePath(state.rootId, stateDirectory);
  if (!target) throw new TypeError('invalid managed goal recovery root id');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, target);
};

export const clearManagedGoalRecoveryState = async (rootId, options = {}) => {
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  const target = statePath(rootId, stateDirectory);
  if (target) await rm(target, { force: true });
};

export const listManagedGoalRecoveryRoots = async (options = {}) => {
  const stateDirectory = options.stateDirectory || defaultStateDirectory();
  try {
    const suffix = '.goal-recovery.json';
    return (await readdir(stateDirectory))
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length))
      .filter((rootId) => ID_PATTERN.test(rootId));
  } catch {
    return [];
  }
};
