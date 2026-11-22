import { isRecord } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

const isJsonRecord = (value: JsonValue | undefined): value is JsonObject => isRecord(value);
const jsonFields = (value: JsonValue | undefined) => isJsonRecord(value) ? value : undefined;
const isJsonArray = (value: JsonValue | undefined): value is JsonValue[] => Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const positiveNumber = (value: unknown): value is number => isFiniteNumber(value) && value > 0;
const isCallable = (value: unknown): value is CallableFunction => typeof value === 'function';
const hasTrim = (value: unknown): value is { trim?: unknown } => value != null;

interface LoopInfo {
  id: string;
  sessionID: JsonValue | undefined;
  time: JsonObject;
}

export interface AssistantInfo extends LoopInfo {
  role: 'assistant';
  summary: boolean;
  agent?: JsonValue | undefined;
  providerID?: JsonValue | undefined;
  modelID?: JsonValue | undefined;
  variant?: JsonValue | undefined;
  finish: JsonValue | undefined;
  tokens: JsonValue | undefined;
  error?: { name: JsonValue | undefined } | undefined;
}

export interface LoopMessage {
  info: AssistantInfo | (LoopInfo & { role: 'user'; synthetic: boolean });
  parts: { type: 'text'; text: string }[];
}

export const toLoopMessage = (raw: JsonValue): LoopMessage | null => {
  const message = jsonFields(raw);
  const id = String(message?.id ?? '');
  if (!id || !message) return null;
  const time: JsonObject = { ...jsonFields(message.time) };
  const base = { id, sessionID: message.sessionID, time };
  switch (message.type) {
    case 'user':
    case 'synthetic':
      return {
        info: { ...base, role: 'user', synthetic: message.type === 'synthetic' },
        parts: message.text ? [{ type: 'text', text: String(message.text) }] : [],
      };
    case 'assistant': {
      const model = jsonFields(message.model) ?? {};
      const error = message.error ? { name: jsonFields(message.error)?.type, ...jsonFields(message.error) } : undefined;
      return {
        info: {
          ...base,
          role: 'assistant',
          summary: false,
          agent: message.agent,
          providerID: model.providerID,
          modelID: model.id,
          variant: model.variant,
          finish: message.finish,
          tokens: message.tokens,
          error,
        },
        parts: (isJsonArray(message.content) ? message.content : [])
          .map(jsonFields)
          .filter((part): part is JsonObject => part?.type === 'text' && Boolean(part.text))
          .map((part) => ({ type: 'text', text: String(part.text) })),
      };
    }
    case 'compaction': {
      if (message.status !== 'completed') return null;
      return {
        info: {
          ...base,
          time: { ...time, completed: time.completed ?? time.created },
          role: 'assistant',
          summary: true,
          tokens: message.tokens,
          finish: 'stop',
        },
        parts: message.summary ? [{ type: 'text', text: String(message.summary) }] : [],
      };
    }
    default:
      return null;
  }
};

export const lastUserMessageCreatedAt = (messages: LoopMessage[], fallback: number) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (info?.role === 'user' && !info.synthetic && isFiniteNumber(info.time?.created)) return info.time.created;
  }
  return fallback;
};

export const messagePartsToText = (message: LoopMessage | null) => {
  const parts = message?.parts ?? [];
  return parts
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n');
};

export const messageTokenTotal = (info: AssistantInfo) => {
  const tokens = jsonFields(info.tokens);
  if (!tokens) return 0;
  const input = isFiniteNumber(tokens.input) ? Math.max(0, tokens.input) : 0;
  const output = isFiniteNumber(tokens.output) ? Math.max(0, tokens.output) : 0;
  const cache = jsonFields(tokens.cache);
  const cachedRead = isFiniteNumber(cache?.read) ? Math.max(0, cache.read) : 0;
  return input + cachedRead + output;
};

export const getErrorName = (error: AssistantInfo['error']) => {
  const name = error?.name;
  const trim = hasTrim(name) ? name.trim : undefined;
  if (trim == null) return '';
  if (!isCallable(trim)) throw new TypeError('error?.name?.trim is not a function');
  const trimmed: unknown = Function.prototype.call.call(trim, name);
  return trimmed ?? '';
};

export const isLengthTruncated = (info: AssistantInfo | undefined, { errorName = getErrorName(info?.error) }: { errorName?: unknown } = {}) => {
  const error = info?.error;
  const hasError = error !== null && error !== undefined;
  return errorName === 'MessageOutputLengthError' || (!hasError && info?.finish === 'length');
};

export const hasRepeatedLengthTail = (messages: LoopMessage[], latestAssistant: LoopMessage | null, goalCreatedAt: number) => {
  const latestInfo = latestAssistant?.info;
  if (!latestAssistant || latestInfo?.role !== 'assistant' || latestInfo.summary === true) return false;
  const latestIndex = messages.indexOf(latestAssistant);
  const latestCreated = latestInfo?.time?.created;
  if (
    latestIndex < 0
    || !(Number(latestInfo.time.completed) > 0)
    || !positiveNumber(latestCreated)
    || !isLengthTruncated(latestInfo)
  ) return false;

  let previous = null;
  for (let i = 0; i < messages.length; i += 1) {
    const info = messages[i]?.info;
    if (info?.role !== 'assistant' || info.summary === true || !(Number(info.time.completed) > 0)) continue;
    const created = info.time?.created;
    if (!positiveNumber(created)) continue;
    if (i === latestIndex) continue;
    if (created > latestCreated || (created === latestCreated && i > latestIndex)) continue;
    if (
      !previous
      || created > previous.created
      || (created === previous.created && i > previous.index)
    ) {
      previous = { info, created, index: i };
    }
  }

  return Boolean(
    previous
    && previous.created > goalCreatedAt
    && isLengthTruncated(previous.info),
  );
};
