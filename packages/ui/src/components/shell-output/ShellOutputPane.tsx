import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TerminalViewport } from '@/components/terminal/TerminalViewport';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/lib/i18n';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { isOpencodeNotFound, opencodeClient } from '@/lib/opencode/client';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { useUIStore } from '@/stores/useUIStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { createShellOutputSubscription } from './shellOutputSubscription';

type Props = {
  shellID: string;
  directory: string;
  label: string;
  visible: boolean;
};

export const ShellOutputPane: React.FC<Props> = ({ shellID, directory, label, visible }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { monoFont } = useFontPreferences();
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const output = React.useMemo(() => createShellOutputSubscription({
    read: (cursor) => opencodeClient.readShellOutput(shellID, directory, cursor),
    isNotFound: isOpencodeNotFound,
    getPresence: () => {
      const index = useBackgroundShellsStore.getState();
      const ended = index.ended.get(shellID);
      return { running: index.byId.has(shellID), ended: ended ? { t: 'ended', status: ended.status, exit: ended.exit } : null };
    },
    subscribePresence: (notify) => useBackgroundShellsStore.subscribe(notify),
    omittedLabel: t('shellOutput.earlierOmitted'),
  }), [directory, shellID, t]);
  const { state, chunks } = React.useSyncExternalStore(output.subscribe, output.getSnapshot, output.getSnapshot);

  const theme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);
  const fontFamily = (CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT]).stack;
  const noop = React.useCallback(() => {}, []);

  const statusLabel = state.kind === 'loading'
    ? t('shellOutput.status.loading')
    : state.kind === 'running'
      ? t('shellOutput.status.running')
      : state.kind === 'unavailable'
        ? t('shellOutput.status.notFound')
        : state.status === 'stopped'
          ? t('shellOutput.status.stopped')
          : state.exit !== undefined
            ? t('shellOutput.status.finishedWithCode', { code: state.exit })
            : t('shellOutput.status.finished');
  const statusTone = state.kind === 'running'
    ? 'text-[var(--status-success)]'
    : state.kind === 'unavailable'
      ? 'text-[var(--status-warning)]'
      : 'text-muted-foreground';

  return (
    <div className="flex h-full w-full flex-col bg-background" data-shell-output={shellID}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Icon name="terminal-window" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground" title={label}>{label}</span>
        <span className={`shrink-0 typography-meta ${statusTone}`} role="status">{statusLabel}</span>
        <span className="shrink-0 typography-micro text-muted-foreground">{t('shellOutput.readOnly')}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.kind === 'unavailable' && chunks.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <span className="typography-meta text-muted-foreground">{statusLabel}</span>
          </div>
        ) : (
          <TerminalViewport
            sessionKey={`shell-output:${shellID}`}
            chunks={chunks}
            onInput={noop}
            onResize={noop}
            theme={theme}
            monoFont={monoFont}
            fontFamily={fontFamily}
            fontSize={fontSize}
            autoFocus={false}
            isVisible={visible}
            className="h-full w-full"
          />
        )}
      </div>
    </div>
  );
};
