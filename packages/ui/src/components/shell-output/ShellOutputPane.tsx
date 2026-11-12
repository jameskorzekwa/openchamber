import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TerminalViewport } from '@/components/terminal/TerminalViewport';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/lib/i18n';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { isOpencodeNotFound, opencodeClient } from '@/lib/opencode/client';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import type { TerminalChunk } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { reduceShellOutputEvent, toTerminalText, type ShellOutputState } from './shellOutputState';

type Props = {
  shellID: string;
  directory: string;
  /** Tab label: the command as the row that opened the panel showed it. */
  label: string;
  visible: boolean;
};

const POLL_INTERVAL_MS = 1_000;
/** A quiet command, such as an idle dev server, is read at most this often. */
const MAX_POLL_INTERVAL_MS = 4_000;

const byteLengthOf = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * Read-only output of a command the agent left running in the background, in
 * the terminal viewport so its colours and progress lines render as they
 * would in a terminal. OpenCode streams a command's output to a file and
 * serves it by byte cursor, with no output event, so the pane reads on from
 * its cursor (as the transcript's running-shell row does) and stops once the
 * shell index reports the command ended and a last read found nothing new.
 */
export const ShellOutputPane: React.FC<Props> = ({ shellID, directory, label, visible }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { monoFont } = useFontPreferences();
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const running = useBackgroundShellsStore(React.useCallback((state) => state.byId.has(shellID), [shellID]));
  const ended = useBackgroundShellsStore(React.useCallback((state) => state.ended.get(shellID), [shellID]));
  const [state, setState] = React.useState<ShellOutputState>({ kind: 'loading' });
  const [chunks, setChunks] = React.useState<TerminalChunk[]>([]);
  const nextChunkId = React.useRef(1);
  const endedRef = React.useRef(false);

  React.useEffect(() => {
    if (running) setState((previous) => reduceShellOutputEvent(previous, { t: 'running' }));
  }, [running]);

  React.useEffect(() => {
    endedRef.current = Boolean(ended);
    if (ended) setState((previous) => reduceShellOutputEvent(previous, { t: 'ended', status: ended.status, exit: ended.exit }));
  }, [ended]);

  React.useEffect(() => {
    let cancelled = false;
    let cursor: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_INTERVAL_MS;
    nextChunkId.current = 1;
    setChunks([]);
    setState({ kind: 'loading' });

    const append = (text: string) => {
      if (!text) return;
      const data = toTerminalText(text);
      const id = nextChunkId.current;
      nextChunkId.current = id + 1;
      setChunks((previous) => [...previous, { id, data, byteLength: byteLengthOf(data) }]);
    };

    const read = async () => {
      let brought = false;
      try {
        const page = await opencodeClient.readShellOutput(shellID, directory, cursor);
        if (cancelled) return;
        const first = cursor === undefined;
        cursor = page.cursor;
        let text = page.output;
        // A first read of a long output starts mid-line; drop the partial line.
        if (first && page.skipped) {
          const lineStart = text.indexOf('\n');
          text = lineStart === -1 ? '' : text.slice(lineStart + 1);
          if (text) append(`${t('shellOutput.earlierOmitted')}\n`);
        }
        append(text);
        brought = text.length > 0;
        setState((previous) => reduceShellOutputEvent(previous, { t: 'page' }));
        delay = first || brought ? POLL_INTERVAL_MS : Math.min(delay * 2, MAX_POLL_INTERVAL_MS);
      } catch (error) {
        if (cancelled) return;
        if (isOpencodeNotFound(error)) {
          setState((previous) => reduceShellOutputEvent(previous, { t: 'not-found' }));
          return;
        }
        // Anything else is retried on the next tick.
      }
      // An ended command gets one more read for its last output, then stops.
      if (endedRef.current && !brought) return;
      if (!cancelled) timer = setTimeout(read, delay);
    };
    void read();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [directory, shellID, t]);

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
