export type TerminalPurpose = { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };

export interface TerminalAppearanceInput {
  themeMode?: unknown;
  terminalBackground?: unknown;
  terminalForeground?: unknown;
}

export interface TerminalRequestFields extends TerminalAppearanceInput {
  cwd?: unknown;
  sessionId?: unknown;
  sessionIds?: unknown;
  cols?: unknown;
  rows?: unknown;
  shell?: unknown;
  loginShell?: unknown;
  mode?: unknown;
  command?: unknown;
  purpose?: unknown;
}

export const MAX_INPUT_CHARS = 65_536;
export const INTERACTIVE_TERMINAL_MODE = 'interactive';
export const COMMAND_TERMINAL_MODE = 'command';
export const TERMINAL_PURPOSE = Object.freeze({ type: 'terminal' });
const MAX_PURPOSE_ID_CHARS = 128;
const OBJECT_TAG = '[object Object]';
const isString = (value: unknown): value is string => String(value) === value;
const isObjectRecord = (value: unknown): value is { type?: unknown; actionId?: unknown; executionId?: unknown } => value != null && !Array.isArray(value) && Object.prototype.toString.call(value) === OBJECT_TAG;
type CreateMode = { mode: 'interactive'; command: null } | { mode: 'command'; command: string };
export const normalizeCreateMode = ({ mode, command }: Pick<TerminalRequestFields, 'mode' | 'command'>): CreateMode => {
  const normalizedMode = mode == null ? INTERACTIVE_TERMINAL_MODE : mode;
  if (normalizedMode !== INTERACTIVE_TERMINAL_MODE && normalizedMode !== COMMAND_TERMINAL_MODE) throw new Error('Invalid terminal mode');
  if (normalizedMode === INTERACTIVE_TERMINAL_MODE) {
    if (command != null) throw new Error('Interactive terminal create does not accept a command');
    return { mode: INTERACTIVE_TERMINAL_MODE, command: null };
  }
  if (!isString(command) || !command.trim()) throw new Error('Terminal command is required');
  const trimmedCommand = command.trim();
  if (trimmedCommand.length > MAX_INPUT_CHARS) throw new Error('Terminal command exceeds the input limit');
  return { mode: COMMAND_TERMINAL_MODE, command: trimmedCommand };
};
const normalizePurposeId = (value: string, errorMessage: string) => {
  if (!value.trim()) throw new Error(errorMessage);
  const normalized = value.trim();
  if (normalized.length > MAX_PURPOSE_ID_CHARS) throw new Error(errorMessage);
  return normalized;
};
export const normalizeTerminalPurpose = ({ purpose: value }: Pick<TerminalRequestFields, 'purpose'>): TerminalPurpose => {
  if (value == null) return TERMINAL_PURPOSE;
  if (!isObjectRecord(value)) throw new Error('Invalid terminal purpose');
  if (value.type === 'terminal') return TERMINAL_PURPOSE;
  if (value.type !== 'project-action') throw new Error('Invalid terminal purpose');
  const actionIdError = 'Terminal project action id is required';
  const executionIdError = 'Terminal execution id is required';
  const rawActionId = value.actionId;
  if (!isString(rawActionId)) throw new Error(actionIdError);
  const actionId = normalizePurposeId(rawActionId, actionIdError);
  const rawExecutionId = value.executionId;
  if (!isString(rawExecutionId)) throw new Error(executionIdError);
  const executionId = normalizePurposeId(rawExecutionId, executionIdError);
  return { type: 'project-action', actionId, executionId };
};
