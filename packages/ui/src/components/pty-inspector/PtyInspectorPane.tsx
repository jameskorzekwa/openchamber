import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TerminalViewport } from '@/components/terminal/TerminalViewport';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/lib/i18n';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { connectPtyInspector, fetchPtySession } from '@/lib/ptyInspectorApi';
import { reducePtyInspectorEvent, type PtyInspectorState } from './ptyInspectorState';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import type { TerminalChunk } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  ptyId: string;
  visible: boolean;
};

const RECONNECT_DELAY_MS = 3000;

const byteLengthOf = (text: string): number => new TextEncoder().encode(text).byteLength;

export const PtyInspectorPane: React.FC<Props> = ({ ptyId, visible }) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { monoFont } = useFontPreferences();
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const [state, setState] = React.useState<PtyInspectorState>({ kind: 'connecting' });
  const [chunks, setChunks] = React.useState<TerminalChunk[]>([]);
  const nextChunkId = React.useRef(1);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    setState({ kind: 'connecting' });
    // The stream only reports status changes; the record gives the title and
    // the current status for a process that is already running or finished.
    let cancelled = false;
    void fetchPtySession(ptyId).then((session) => {
      if (cancelled || !session) return;
      setState((previous) => reducePtyInspectorEvent(previous, { t: 'session', session }));
    }).catch(() => {
      // The socket reports reachability; a failed lookup only leaves the id as title.
    });
    const connection = connectPtyInspector(ptyId, (event) => {
      if (event.t === 'snapshot') {
        // The backlog replaces anything a previous connection delivered.
        nextChunkId.current = 2;
        setChunks([{ id: 1, data: event.data, byteLength: byteLengthOf(event.data) }]);
      } else if (event.t === 'data') {
        const id = nextChunkId.current;
        nextChunkId.current = id + 1;
        setChunks((previous) => [...previous, { id, data: event.data, byteLength: byteLengthOf(event.data) }]);
      }
      setState((previous) => reducePtyInspectorEvent(previous, event));
    });
    return () => {
      cancelled = true;
      connection.close();
    };
  }, [ptyId, attempt]);

  // A dropped socket while the process may still be running is retried; a
  // finished process or a hard failure waits for the user.
  React.useEffect(() => {
    if (state.kind !== 'unavailable' || state.reason !== 'closed') return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), RECONNECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const theme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);
  const fontFamily = (CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT]).stack;
  const noop = React.useCallback(() => {}, []);

  const session = state.kind === 'live' || state.kind === 'ended' ? state.session : null;
  const title = session?.title?.trim() || session?.description?.trim() || ptyId;
  const statusLabel = state.kind === 'connecting'
    ? t('ptyInspector.status.connecting')
    : state.kind === 'live'
      ? t('ptyInspector.status.running')
      : state.kind === 'ended'
        ? (session?.exitCode != null
          ? t('ptyInspector.status.exitedWithCode', { code: session.exitCode })
          : t('ptyInspector.status.exited'))
        : state.reason === 'not-found'
          ? t('ptyInspector.status.notFound')
          : state.reason === 'misconfigured'
            ? t('ptyInspector.status.misconfigured')
            : t('ptyInspector.status.unreachable');
  const statusTone = state.kind === 'live'
    ? 'text-[var(--status-success)]'
    : state.kind === 'unavailable'
      ? 'text-[var(--status-warning)]'
      : 'text-muted-foreground';

  return (
    <div className="flex h-full w-full flex-col bg-background" data-pty-inspector={ptyId}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Icon name="terminal-window" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={title}>{title}</span>
        <span className={`shrink-0 typography-meta ${statusTone}`} role="status">{statusLabel}</span>
        <span className="shrink-0 typography-micro text-muted-foreground">{t('ptyInspector.readOnly')}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.kind === 'unavailable' && chunks.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <span className="typography-meta text-muted-foreground">{statusLabel}</span>
          </div>
        ) : (
          <TerminalViewport
            sessionKey={`pty-inspector:${ptyId}`}
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
