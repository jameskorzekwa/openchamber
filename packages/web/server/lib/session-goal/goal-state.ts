import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMergedSettingsSync } from '../settings/settings-files.js';
import { isRecord, isString } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { GeneratedTextResult } from '../small-model/index.js';
import { GOAL_OBJECTIVE_CHAR_LIMIT } from './objectives.js';

export type GoalChecker = 'classifier' | 'small-model';
type GoalStatus = typeof GOAL_STATUSES[number];
interface GoalSettings {
  enabled: boolean;
  checker: GoalChecker;
  maxAutoTurns: number;
}

export interface SessionGoal {
  id: string;
  objective: string;
  objectiveFile: boolean;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  tokensBaseline: number;
  tokensCommitted: number;
  turnsUsed: number;
  auditFailStreak: number;
  statusReason: string;
  evaluationProviderID: GeneratedTextResult['providerID'];
  evaluationModelID: GeneratedTextResult['modelID'];
  lastAccountedMessageID: string;
  createdAt: number;
  updatedAt: number;
}

export type SettledGoalStatus = 'blocked' | 'budgetLimited' | 'complete';

export interface GoalSession {
  sessionId: string;
  directory: string;
  goal: SessionGoal;
}

export interface GoalSettlement extends GoalSession, Partial<Pick<SessionGoal, 'tokensUsed' | 'tokensBaseline' | 'tokensCommitted' | 'lastAccountedMessageID' | 'evaluationProviderID' | 'evaluationModelID'>> {
  status: SettledGoalStatus;
  statusReason: unknown;
  isCurrent?: (() => boolean) | null;
}

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const positiveNumber = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
const isJsonRecord = (value: JsonValue | undefined): value is JsonObject => isRecord(value);
const jsonFields = (value: JsonValue | undefined) => isJsonRecord(value) ? value : undefined;
const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);
export const REASON_CHAR_LIMIT = 200;
const DEFAULT_MAX_AUTO_TURNS = 20;
const MAX_AUTO_TURNS_LIMIT = 200;
const GOAL_STATUSES = ['active', 'paused', 'blocked', 'budgetLimited', 'complete'] as const;
const isGoalStatus = (value: unknown): value is GoalStatus => GOAL_STATUSES.some((status) => status === value);

export const normalizeMaxAutoTurns = (value: JsonValue | undefined) => (
  isInteger(value) && value >= 1 && value <= MAX_AUTO_TURNS_LIMIT ? value : DEFAULT_MAX_AUTO_TURNS
);

export const readGoalSettings = (): GoalSettings => {
  const settings = readMergedSettingsSync({ fs, path, settingsFilePath: OPENCHAMBER_SETTINGS_FILE });
  return {
    enabled: settings.sessionGoalEnabled !== false,
    checker: settings.sessionGoalChecker === 'classifier' ? 'classifier' : 'small-model',
    maxAutoTurns: normalizeMaxAutoTurns(isFiniteNumber(settings.sessionGoalMaxAutoTurns) ? settings.sessionGoalMaxAutoTurns : undefined),
  };
};

export const isSessionGoalEnabled = () => readGoalSettings().enabled;

export const extractSessionStatus = (payload: JsonObject | undefined) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = jsonFields(payload.properties) ?? {};
  const status = jsonFields(properties.status) ?? {};
  const info = jsonFields(properties.info) ?? {};
  const sessionId = isString(properties.sessionID) ? properties.sessionID.trim() : '';
  const type = isString(status.type)
    ? status.type.trim()
    : (isString(info.type) ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = isString(properties.directory) && properties.directory
    ? properties.directory
    : (isString(info.directory) ? info.directory : '');
  return { sessionId, type, directory };
};

export const extractAbortedAssistant = (payload: JsonObject | undefined) => {
  if (!payload || payload.type !== 'session.idle') return null;
  const properties = jsonFields(payload.properties);
  if (!properties || properties.aborted !== true) return null;
  if (!isString(properties.sessionID) || !properties.sessionID) return null;
  return { sessionId: properties.sessionID };
};

export const extractSessionUpdate = (payload: JsonObject | undefined) => {
  if (!payload || payload.type !== 'session.updated') return null;
  const info = jsonFields(jsonFields(payload.properties)?.info);
  if (!info || !isString(info.id) || !info.id) return null;
  return {
    sessionId: info.id,
    directory: isString(info.directory) ? info.directory : '',
    parentID: isString(info.parentID) ? info.parentID : '',
  };
};

export const parseGoalMetadata = (session: { metadata?: unknown } | undefined) => {
  const metadata = session?.metadata;
  if (!isRecord(metadata)) return null;
  const namespace = metadata.openchamber;
  if (!isRecord(namespace)) return null;
  const goal = namespace.goal;
  if (!isRecord(goal)) return null;
  const objective = isString(goal.objective) ? goal.objective.trim() : '';
  const objectiveFile = goal.objectiveFile === true;
  const id = isString(goal.id) ? goal.id : '';
  const status = isGoalStatus(goal.status) ? goal.status : '';
  if (!id || !status || (!objective && !objectiveFile)) return null;
  return {
    id,
    objective: objective.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT),
    objectiveFile,
    status,
    tokenBudget: positiveNumber(goal.tokenBudget) ? Math.floor(goal.tokenBudget) : null,
    tokensUsed: positiveNumber(goal.tokensUsed) ? Math.floor(goal.tokensUsed) : 0,
    tokensBaseline: positiveNumber(goal.tokensBaseline) ? Math.floor(goal.tokensBaseline) : 0,
    tokensCommitted: positiveNumber(goal.tokensCommitted) ? Math.floor(goal.tokensCommitted) : 0,
    turnsUsed: positiveNumber(goal.turnsUsed) ? Math.floor(goal.turnsUsed) : 0,
    auditFailStreak: positiveNumber(goal.auditFailStreak) ? Math.floor(goal.auditFailStreak) : 0,
    statusReason: isString(goal.statusReason) ? goal.statusReason.slice(0, REASON_CHAR_LIMIT) : '',
    evaluationProviderID: isString(goal.evaluationProviderID) ? goal.evaluationProviderID : '',
    evaluationModelID: isString(goal.evaluationModelID) ? goal.evaluationModelID : '',
    lastAccountedMessageID: isString(goal.lastAccountedMessageID) ? goal.lastAccountedMessageID : '',
    createdAt: isFiniteNumber(goal.createdAt) ? goal.createdAt : 0,
    updatedAt: isFiniteNumber(goal.updatedAt) ? goal.updatedAt : 0,
  };
};
