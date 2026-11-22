import { hasErrorMessage, isJsonObject, isString } from './inputs.js';
import { truncateNotificationText } from './message.js';
import type { JsonValue, StoredSessionMetadata } from './contracts.js';
import type { NotificationTriggerEvent, TriggerInfo } from './runtime.js';

type JsonField = JsonValue | undefined;
interface PermissionPrefixes {
  [action: string]: string | { toString(): string } | undefined;
}
export const PERMISSION_PREFIX_BY_ACTION: PermissionPrefixes = {
  bash: 'Wants to run',
  edit: 'Wants to edit',
  read: 'Wants to read',
};
export const LOCATION_SCOPED_FORM_SESSION_ID = 'global';
export const phoneBodyOf = (prefix: PermissionPrefixes[string], text: string) => {
  const detail = truncateNotificationText((text ?? '').trim());
  if (!detail) return '';
  return prefix ? `${prefix}: ${detail}` : detail;
};
export const jsonField = (value: JsonField | StoredSessionMetadata, key: string): JsonField => isJsonObject(value) ? value[key] : undefined;
export const isJsonArray = (value: JsonField): value is JsonValue[] => Array.isArray(value);
export const errorMessage = (cause: unknown) => hasErrorMessage(cause) ? cause.message : undefined;
export const isTriggerEvent = (event: NotificationTriggerEvent | null | undefined): event is NotificationTriggerEvent =>
  event !== null && typeof event === 'object';
export const localeOf = (value: JsonField) => {
  if (jsonField(value, 'trim') != null) throw new TypeError('value?.trim is not a function');
  return isString(value) ? value : undefined;
};
export const templateOf = (entry: JsonField) => {
  const title = jsonField(entry, 'title');
  const message = jsonField(entry, 'message');
  if (jsonField(title, 'trim') != null || jsonField(message, 'trim') != null) throw new TypeError('candidate?.trim is not a function');
  return { title: isString(title) ? title : '', message: isString(message) ? message : '' };
};

export const readFormAsk = (payload: NotificationTriggerEvent) => {
  const form = payload.properties?.form;
  const header = isString(form?.title) ? form.title.trim() : '';
  const firstField = isJsonArray(form?.fields) ? form.fields[0] : null;
  const title = jsonField(firstField, 'title');
  const description = jsonField(firstField, 'description');
  const fieldTitle = isString(title) ? title.trim() : '';
  const fieldDescription = isString(description) ? description.trim() : '';
  const id = form?.id || null;
  return { id, header, questionText: fieldDescription || fieldTitle };
};

export const readPageAsk = (payload: NotificationTriggerEvent) => {
  const { id, title } = payload.properties?.page ?? {};
  return {
    id: id || null,
    header: '',
    questionText: String(title ?? '').trim(),
  };
};

export const extractSessionIdFromPayload = (payload: NotificationTriggerEvent) => {
  if (!isTriggerEvent(payload)) return null;
  const props = payload.properties;
  const info = props?.info;
  const sessionId =
    info?.sessionID ??
    info?.sessionId ??
    props?.sessionID ??
    props?.sessionId ??
    props?.session ??
    null;
  return isString(sessionId) && sessionId.length > 0 ? sessionId : null;
};

export const extractDirectoryFromPayload = (payload: NotificationTriggerEvent) => {
  if (!isTriggerEvent(payload)) return undefined;
  const props = payload.properties;
  const directory = props?.directory ?? props?.info?.directory;
  if (!isString(directory)) return undefined;
  const trimmed = directory.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const formatMode = (raw: TriggerInfo['mode']) => {
  const value = isString(raw) ? raw.trim() : '';
  const normalized = value.length > 0 ? value : 'agent';
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(' ');
};

export const formatModelId = (raw: TriggerInfo['modelID']) => {
  const value = isString(raw) ? raw.trim() : '';
  if (!value) {
    return 'Assistant';
  }

  const tokens = value.split(/[-_]+/).filter(Boolean);
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i] ?? '';
    const next = tokens[i + 1];
    if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
      result.push(`${current}.${next}`);
      i += 1;
      continue;
    }
    result.push(current);
  }

  return result
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};
