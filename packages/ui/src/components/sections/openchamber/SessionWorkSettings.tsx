import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { resetSessionWorkAutoDoneCooldown, SESSION_WORK_AUTO_DONE_DAY_OPTIONS } from '@/sync/session-work-auto-done';

export const SessionWorkSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.sessionWorkEnabled);
  const setEnabled = useUIStore((state) => state.setSessionWorkEnabled);
  const autoDoneDays = useUIStore((state) => state.sessionWorkAutoDoneDays);
  const setAutoDoneDays = useUIStore((state) => state.setSessionWorkAutoDoneDays);
  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);
  const showSubagentSessions = useSessionDisplayStore((state) => state.showSubagentSessions);
  const setShowSubagentSessions = useSessionDisplayStore((state) => state.setShowSubagentSessions);

  const dayOptions = React.useMemo(() => {
    const values = new Set<number>(SESSION_WORK_AUTO_DONE_DAY_OPTIONS);
    if (autoDoneDays > 0) values.add(autoDoneDays);
    return [...values].sort((a, b) => a - b);
  }, [autoDoneDays]);

  return (
    <SettingsSection
      title={t('settings.layout.sessions.sidebar.title')}
      settingsItem="sessions.work"
      contentClassName="space-y-3"
    >
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        {isVSCodeRuntime() ? null : (
          <SettingsCheckboxRow
            settingsItem="sessions.show-chats"
            checked={showChatsSection}
            onChange={(checked) => {
              setShowChatsSection(checked);
              void updateDesktopSettings({ sidebarShowChatsSection: checked });
            }}
            label={t('settings.openchamber.defaults.field.showChats')}
            ariaLabel={t('settings.openchamber.defaults.field.showChats')}
          />
        )}
        <SettingsCheckboxRow
          settingsItem="sessions.show-subagents"
          checked={showSubagentSessions}
          onChange={(checked) => {
            setShowSubagentSessions(checked);
            void updateDesktopSettings({ sidebarShowSubagentSessions: checked });
          }}
          label={t('settings.openchamber.defaults.field.showSubagents')}
          ariaLabel={t('settings.openchamber.defaults.field.showSubagents')}
          info={t('settings.openchamber.defaults.field.showSubagentsInfo')}
        />
        <SettingsCheckboxRow
          settingsItem="sessions.work-enabled"
          checked={enabled}
          onChange={setEnabled}
          label={t('settings.openchamber.sessionWork.field.enabled')}
          ariaLabel={t('settings.openchamber.sessionWork.field.enabled')}
          info={t('settings.openchamber.sessionWork.info')}
        />
      </div>
      <SettingsFieldRow
        settingsItem="sessions.work-auto-done"
        label={t('settings.openchamber.sessionWork.field.autoDone')}
        info={t('settings.openchamber.sessionWork.field.autoDoneInfo')}
      >
        <Select
          value={String(autoDoneDays)}
          disabled={!enabled}
          onValueChange={(value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            if (parsed > 0) resetSessionWorkAutoDoneCooldown();
            setAutoDoneDays(parsed);
          }}
        >
          <SelectTrigger
            aria-label={t('settings.openchamber.sessionWork.field.autoDone')}
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          >
            <SelectValue>
              {autoDoneDays === 0
                ? t('settings.openchamber.sessionWork.field.autoDoneOff')
                : t('settings.openchamber.sessionWork.field.autoDoneDays', { count: autoDoneDays })}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {dayOptions.map((days) => (
              <SelectItem key={days} value={String(days)}>
                {days === 0
                  ? t('settings.openchamber.sessionWork.field.autoDoneOff')
                  : t('settings.openchamber.sessionWork.field.autoDoneDays', { count: days })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
    </SettingsSection>
  );
};
