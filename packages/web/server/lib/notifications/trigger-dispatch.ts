import { isString } from './inputs.js';
import { keepNewest } from './push-tags.js';
import type { createPushTags, PushClaim } from './push-tags.js';
import type { JsonValue, NotificationPayload } from './contracts.js';
import type {
  NotificationTriggerDependencies, NotificationTriggerEvent, TriggerInfo, TriggerSource,
  TriggerPushPayload, PushOptions, ChannelNotice, NotificationTriggerSettings, AutoAcceptResolver,
} from './runtime.js';
import {
  jsonField, isJsonArray, errorMessage, isTriggerEvent, localeOf, templateOf,
  readFormAsk, readPageAsk, extractSessionIdFromPayload, extractDirectoryFromPayload,
  formatMode, formatModelId, phoneBodyOf, PERMISSION_PREFIX_BY_ACTION, LOCATION_SCOPED_FORM_SESSION_ID,
} from './trigger-inputs.js';
import { defaultNotificationTemplates, notificationTexts, renderNotificationText, withTemplateDefaults } from './template-locales.js';

interface TriggerDispatchDependencies {
  deps: NotificationTriggerDependencies;
  pushTags: ReturnType<typeof createPushTags>;
  sessionClearedAt: Map<string, number>;
  sourceFor: (spaceId: string | null) => TriggerSource;
  maybeCacheSessionParentFromPayload: (payload: NotificationTriggerEvent, spaceId: string | null) => void;
  clearSessionPushNotifications: (sessionId: string, options?: { turnStart?: boolean; viewed?: boolean }) => Promise<void>;
  isPausedForSubagents: (sessionId: string, spaceId: string | null) => Promise<boolean>;
  getParentIdFromPayload: (payload: NotificationTriggerEvent) => string | null | undefined;
  fetchSessionParentId: (sessionId: string, directory: string | undefined, spaceId?: string | null) => Promise<string | null | undefined>;
  hasActiveSessionGoal: (sessionId: string, spaceId: string | null) => Promise<boolean>;
  isSessionAutoAccepting: (sessionId: string, directory: string | undefined) => Promise<boolean>;
  getIsSessionAutoAccepting: (...args: Parameters<AutoAcceptResolver>) => ReturnType<AutoAcceptResolver> | undefined;
  getIsWindowFocused: () => boolean | undefined;
  showInOpenClients: (payload: NotificationPayload) => void;
  fanoutPush: (payload: TriggerPushPayload & { phoneBody: string; claim?: PushClaim }, options: PushOptions) => Promise<void | void[]>;
  sendToChannels: (notice: ChannelNotice, settings: NotificationTriggerSettings) => void;
  buildSessionDeepLinkUrl: (sessionId: string | undefined) => string;
}

export function createTriggerDispatch({
  deps, pushTags, sessionClearedAt, sourceFor, maybeCacheSessionParentFromPayload,
  clearSessionPushNotifications, isPausedForSubagents, getParentIdFromPayload,
  fetchSessionParentId, hasActiveSessionGoal, isSessionAutoAccepting,
  getIsSessionAutoAccepting, getIsWindowFocused, showInOpenClients, fanoutPush,
  sendToChannels, buildSessionDeepLinkUrl,
}: TriggerDispatchDependencies) {
  const {
    readSettingsFromDisk, prepareNotificationLastMessage, buildTemplateVariables,
    extractLastMessageText, fetchLastAssistantMessageText, resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage, isInAutoReview = () => false,
  } = deps;
  const { claimTag: claimPushTag, release: releaseClaim, clearTag: clearPushTag, isCurrent: isClaimCurrent } = pushTags;
  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  type Timer = ReturnType<typeof setTimeout>;
  const pushQuestionDebounceTimers = new Map<string, { timer: Timer; cause: JsonValue }>();
  const pushPermissionDebounceTimers = new Map<string, { timer: Timer; requestKey: string | null }>();
  const notifiedPermissionRequests = new Set<string>();
  const lastReadyNotificationAt = new Map<string, number>();
  const lastErrorNotificationAt = new Map<string, number>();

  const ASSISTANT_STEP_CACHE_LIMIT = 500;
  const assistantStepMeta = new Map<string, { agent: string; modelID: string }>();
  const lastAssistantStepBySession = new Map<string, string>();
  const rememberAssistantStep = (info: TriggerInfo | undefined) => {
    if (!info || info.role !== 'assistant') return;
    const id = String(info.id ?? '');
    const agent = String(info.agent ?? info.mode ?? '');
    const modelID = String(info.modelID ?? '');
    if (!id || (!agent && !modelID)) return;
    assistantStepMeta.delete(id);
    assistantStepMeta.set(id, { agent, modelID });
    const sessionId = String(info.sessionID ?? '');
    if (sessionId) {
      lastAssistantStepBySession.delete(sessionId);
      lastAssistantStepBySession.set(sessionId, id);
      keepNewest(lastAssistantStepBySession, ASSISTANT_STEP_CACHE_LIMIT);
    }
    keepNewest(assistantStepMeta, ASSISTANT_STEP_CACHE_LIMIT);
  };
  const withRememberedStep = (info: TriggerInfo | undefined) => {
    const remembered = info ? assistantStepMeta.get(String(info.id ?? '')) : undefined;
    if (!remembered || !info) return info;
    const merged = { ...info };
    if (!merged.agent && !merged.mode) {
      merged.agent = remembered.agent;
      merged.mode = remembered.agent;
    }
    if (!merged.modelID) merged.modelID = remembered.modelID;
    return merged;
  };

  const maybeSendPushForTrigger = async (payload: NotificationTriggerEvent | null | undefined, { spaceId = null }: { spaceId?: string | null } = {}) => {
    if (!isTriggerEvent(payload)) {
      return;
    }

    maybeCacheSessionParentFromPayload(payload, spaceId);
    const source = sourceFor(spaceId);

    const sessionId = extractSessionIdFromPayload(payload);
    const notificationDirectory = extractDirectoryFromPayload(payload);

    if (payload.type === 'session.status' && sessionId
      && payload.properties?.status?.type === 'busy' && Number.isFinite(payload.properties?.turnStartedAt)) {
      await clearSessionPushNotifications(sessionId, { turnStart: true });
      return;
    }

    const settledAskId = payload.type === 'form.settled' ? payload.properties?.formID
      : payload.type === 'openchamber:page-settled' ? payload.properties?.pageID
        : undefined;
    if (settledAskId !== undefined && sessionId) {
      const cause = settledAskId || null;
      const pending = pushQuestionDebounceTimers.get(sessionId);
      if (pending && (cause === null || pending.cause === null || pending.cause === cause)) {
        clearTimeout(pending.timer);
        pushQuestionDebounceTimers.delete(sessionId);
      }
      await clearPushTag(`question-${sessionId}`, cause);
      return;
    }

    if (payload.type === 'session.idle' && payload.properties?.aborted === true) {
      return;
    }

    if ((payload.type === 'session.idle' || payload.type === 'session.error') && sessionId) {
      const turnEndedAt = Date.now();
      if (payload.type === 'session.idle' && await isPausedForSubagents(sessionId, spaceId)) {
        return;
      }
      const error = payload.properties?.error;
      const message = jsonField(error, 'message');
      const errorText = isString(message)
        ? message
        : isString(error) ? error : '';
      const info: TriggerInfo = {
        id: lastAssistantStepBySession.get(sessionId),
        sessionID: sessionId,
        role: 'assistant',
        finish: payload.type === 'session.error' ? 'error' : 'stop',
      };
      if (errorText) info.parts = [{ type: 'text', text: errorText }];
      await maybeSendPushForTrigger({
        ...payload,
        type: 'message.updated',
        properties: {
          ...payload.properties,
          turnEnded: true,
          turnEndedAt,
          info,
        },
      }, { spaceId });
      return;
    }

    if (payload.type === 'message.updated') {
      rememberAssistantStep(payload.properties?.info);
      const info = withRememberedStep(payload.properties?.info);
      if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId && payload.properties?.turnEnded === true) {
        payload = { ...payload, properties: { ...payload.properties, info } };
        const settings = await readSettingsFromDisk();

        if (settings.notifyOnSubtasks === false) {
          const parentIDFromPayload = getParentIdFromPayload(payload);
          const parentID = parentIDFromPayload
            ? parentIDFromPayload
            : await fetchSessionParentId(sessionId, notificationDirectory, spaceId);

          if (parentID !== null) {
            return;
          }
        }

        if (settings.notifyOnCompletion === false) {
          return;
        }

        if (await hasActiveSessionGoal(sessionId, spaceId)) {
          return;
        }

        if (!spaceId && isInAutoReview(sessionId, payload.properties?.turnEndedAt ?? Date.now())) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const now = Date.now();
        const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
          return;
        }
        lastReadyNotificationAt.set(sessionId, now);

        const readyTag = `ready-${sessionId}`;
        const claim = await claimPushTag(readyTag, { sessionId, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(readyTag, claim);
          return;
        }

        const texts = notificationTexts(localeOf(settings.locale));
        let title = renderNotificationText(texts.readyTitle, {
          agent_name: formatMode(info?.mode),
        });
        let body = renderNotificationText(texts.readyMessage, {
          model_name: formatModelId(info?.modelID),
        });
        let sessionName = '';
        let reply = '';

        try {
          const templates = settings.notificationTemplates;
          const defaults = defaultNotificationTemplates(localeOf(settings.locale));
          const isSubtask = await fetchSessionParentId(sessionId, notificationDirectory, spaceId);
          const usesSubtaskTemplate = Boolean(isSubtask) && settings.notifyOnSubtasks !== false;
          const completion = jsonField(templates, 'completion');
          const completionTemplate = withTemplateDefaults(
            templateOf(usesSubtaskTemplate ? (jsonField(templates, 'subtask') ?? completion) : completion),
            usesSubtaskTemplate ? defaults.subtask : defaults.completion,
          );

          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;

          const messageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, messageId, undefined, source);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });
          reply = variables.last_message;

          const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(readyTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `ready-${sessionId}`,
            kind: 'ready',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('', reply),
            claim,
            tag: `ready-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'ready',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'ready', title, body, tag: `ready-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
        if (jsonField(info.error, 'type') === 'aborted') {
          return;
        }

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnError === false) return;

        const now = Date.now();
        const lastAt = lastErrorNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) return;
        lastErrorNotificationAt.set(sessionId, now);

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const errorTag = `error-${sessionId}`;
        const claim = await claimPushTag(errorTag, { sessionId, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(errorTag, claim);
          return;
        }

        const texts = notificationTexts(localeOf(settings.locale));
        let title = texts.errorTitle;
        let body = texts.errorBody;
        let sessionName = '';
        let errorText = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          const errorMessageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId, undefined, source);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });
          errorText = variables.last_message;

          const errorTemplate = withTemplateDefaults(
            templateOf(jsonField(settings.notificationTemplates, 'error')),
            defaultNotificationTemplates(localeOf(settings.locale)).error,
          );
          const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Error template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(errorTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `error-${sessionId}`,
            kind: 'error',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Error', errorText),
            claim,
            tag: `error-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'error',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'error', title, body, tag: `error-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }

      return;
    }

    const ask = payload.type === 'form.created' ? readFormAsk(payload)
      : payload.type === 'openchamber:page-waiting' ? readPageAsk(payload)
        : null;
    if (ask && sessionId) {
      const askedAt = Date.now();
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);
        const questionTag = `question-${sessionId}`;
        const claim = await claimPushTag(questionTag, { sessionId, cause: ask.id, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= askedAt) {
          releaseClaim(questionTag, claim);
          return;
        }

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false
          || (settings.notificationMode !== 'always' && getIsWindowFocused?.())) {
          releaseClaim(questionTag, claim);
          return;
        }

        const { header, questionText } = ask;
        const formSessionId = sessionId === LOCATION_SCOPED_FORM_SESSION_ID ? undefined : sessionId;

        const texts = notificationTexts(localeOf(settings.locale));
        let title = /plan\s*mode/i.test(header)
          ? texts.planModeTitle
          : /build\s*agent/i.test(header)
            ? texts.buildModeTitle
            : header || texts.questionTitle;
        let body = questionText || texts.questionBody;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, formSessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates;
          const questionTemplate = withTemplateDefaults(
            templateOf(jsonField(templates, 'question')),
            defaultNotificationTemplates(localeOf(settings.locale)).question,
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(questionTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId: formSessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Question', questionText || header),
            claim,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(formSessionId),
              sessionId: formSessionId,
              sessionName,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'question', title, body, tag: `question-${sessionId}`, sessionId: formSessionId, directory: notificationDirectory, sessionName }, settings);
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, { timer, cause: ask.id });
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = requestId ? `${sessionId}:${requestId}` : null;
      if (requestKey) notifiedPermissionRequests.add(requestKey);
      await clearPushTag(`permission-${sessionId}`, requestKey);
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      const requestId = payload.properties?.id ?? payload.properties?.requestID ?? payload.properties?.requestId;
      const permissionAction = isString(payload.properties?.action) ? payload.properties.action.trim() : '';
      const permissionResource = isJsonArray(payload.properties?.resources)
        ? String(payload.properties.resources[0] ?? '').trim()
        : '';
      const permissionMessage = isString(payload.properties?.message) ? payload.properties.message.trim() : '';
      const permission = permissionMessage
        || (permissionAction && permissionResource ? `${permissionAction}: ${permissionResource}` : permissionAction);
      const permissionPrefix = PERMISSION_PREFIX_BY_ACTION[permissionAction];
      const permissionPhoneBody = permissionPrefix && permissionResource
        ? phoneBodyOf(permissionPrefix, permissionResource)
        : phoneBodyOf('Wants permission', permission);
      const requestKey = isString(requestId) ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }
      const askedAt = Date.now();
      const isHandledSince = () => (requestKey !== null && notifiedPermissionRequests.has(requestKey))
        || (sessionClearedAt.get(sessionId) ?? 0) >= askedAt;

      const isAutoAnswered = async () => !spaceId && await (getIsSessionAutoAccepting?.(sessionId, notificationDirectory, requestId)
        ?? isSessionAutoAccepting(sessionId, notificationDirectory));
      if (await isAutoAnswered()) {
        if (requestKey) notifiedPermissionRequests.add(requestKey);
        return;
      }
      if (isHandledSince()) return;

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);
        const permissionTag = `permission-${sessionId}`;
        const claim = await claimPushTag(permissionTag, { sessionId, cause: requestKey, spaceId });
        if (isHandledSince()) {
          releaseClaim(permissionTag, claim);
          return;
        }

        if (await isAutoAnswered()) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          releaseClaim(permissionTag, claim);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false
          || (settings.notificationMode !== 'always' && getIsWindowFocused?.())) {
          releaseClaim(permissionTag, claim);
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const texts = notificationTexts(localeOf(settings.locale));
        const fallbackMessage = permission
          || (isString(sessionTitle) && sessionTitle.trim().length > 0 ? sessionTitle.trim() : '')
          || texts.permissionBody;

        let title = texts.permissionTitle;
        let body = fallbackMessage;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates;
          const questionDefaults = defaultNotificationTemplates(localeOf(settings.locale)).question;
          const questionTemplate = withTemplateDefaults(
            templateOf(jsonField(templates, 'question')),
            { ...questionDefaults, title: texts.permissionTitle },
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(permissionTag, claim)) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          return;
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: permissionPhoneBody,
            claim,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'permission', title, body, tag: `permission-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };
  return maybeSendPushForTrigger;
}
