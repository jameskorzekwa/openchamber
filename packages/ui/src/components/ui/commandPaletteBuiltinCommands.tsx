import { Icon } from '@/components/icon/Icon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { useUIStore } from '@/stores/useUIStore';
import type { useI18n } from '@/lib/i18n';
import {
  copyCurrentSessionId,
  openArchive,
  openMultiRun,
  openNotes,
  openOverview,
  openTodos,
  pinCurrentSession,
  reloadUi,
  restartOpenCode,
} from '@/lib/paletteCommands';
import { shortcutRegistry } from '@/lib/shortcuts';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { CommandEntry } from './commandPaletteCreateCommands';
import type { useProjectActions } from '@/components/layout/projectActionsRunnerContext';
import { resolveProjectActionIconName } from '@/lib/projectActions';

type BuiltinCommandsOptions = {
  t: ReturnType<typeof useI18n>['t'];
  run: (fn: () => void | boolean | Promise<void>) => () => void;
  overviewAvailable: boolean;
  setSidebarOpen: (open: boolean) => void;
};

export function secondaryBuiltinCommands({
  t,
  run,
  overviewAvailable,
  setSidebarOpen,
}: BuiltinCommandsOptions): CommandEntry[] {
  const list: CommandEntry[] = [];
  if (!isVSCodeRuntime() && overviewAvailable) {
    list.push({
      id: 'open-overview',
      secondary: true,
      title: t('overview.title'),
      icon: <Icon name="compass-3" className="me-2 h-4 w-4" />,
      shortcutId: 'open_overview',
      searchText: t('overview.title'),
      onSelect: run(openOverview),
    });
  }
  if (!isVSCodeRuntime()) {
    list.push({
      id: 'open-source-board',
      secondary: true,
      title: t('sourceBoard.title'),
      icon: <Icon name="git-pull-request" className="me-2 h-4 w-4" />,
      shortcutId: 'toggle_source_board',
      searchText: t('sourceBoard.title'),
      onSelect: run(() => useUIStore.getState().setSourceBoardOpen(true)),
    });
    list.push({
      id: 'reload-ui',
      secondary: true,
      title: t('commandPalette.item.reloadUi'),
      icon: <Icon name="refresh" className="me-2 h-4 w-4" />,
      shortcutId: 'reload_ui',
      searchText: t('commandPalette.item.reloadUi'),
      onSelect: run(reloadUi),
    });
  }
  list.push(
    {
      id: 'collapse-sessions-all',
      secondary: true,
      title: t('sessions.sidebar.header.displayMode.collapseAll'),
      icon: <Icon name="contract-up-down" className="me-2 h-4 w-4" />,
      shortcutId: 'collapse_sessions_all',
      searchText: t('sessions.sidebar.header.displayMode.collapseAll'),
      onSelect: run(() => {
        setSidebarOpen(true);
        shortcutRegistry.invoke('collapse_sessions_all');
      }),
    },
    {
      id: 'expand-sessions-all',
      secondary: true,
      title: t('sessions.sidebar.header.displayMode.expandAll'),
      icon: <Icon name="expand-up-down" className="me-2 h-4 w-4" />,
      shortcutId: 'expand_sessions_all',
      searchText: t('sessions.sidebar.header.displayMode.expandAll'),
      onSelect: run(() => {
        setSidebarOpen(true);
        shortcutRegistry.invoke('expand_sessions_all');
      }),
    },
    {
      id: 'pin-session',
      secondary: true,
      title: t('commandPalette.item.pinSession'),
      icon: <Icon name="pushpin" className="me-2 h-4 w-4" />,
      shortcutId: 'pin_current_session',
      searchText: t('commandPalette.item.pinSession'),
      onSelect: run(pinCurrentSession(t)),
    },
    {
      id: 'copy-session-id',
      secondary: true,
      title: t('commandPalette.item.copySessionId'),
      icon: <Icon name="file-copy" className="me-2 h-4 w-4" />,
      shortcutId: 'copy_current_session_id',
      searchText: t('commandPalette.item.copySessionId'),
      onSelect: run(copyCurrentSessionId(t)),
    },
    {
      id: 'open-multi-run',
      secondary: true,
      title: t('commandPalette.item.openMultiRun'),
      icon: <ArrowsMerge className="me-2 h-4 w-4" />,
      shortcutId: 'open_multi_run',
      searchText: t('commandPalette.item.openMultiRun'),
      onSelect: run(openMultiRun),
    },
    {
      id: 'open-archive',
      secondary: true,
      title: t('commandPalette.item.openArchive'),
      icon: <Icon name="archive" className="me-2 h-4 w-4" />,
      shortcutId: 'open_archive',
      searchText: t('commandPalette.item.openArchive'),
      onSelect: run(openArchive),
    },
    {
      id: 'open-notes',
      secondary: true,
      title: t('commandPalette.item.openNotes'),
      icon: <Icon name="sticky-note" className="me-2 h-4 w-4" />,
      shortcutId: 'open_notes',
      searchText: t('commandPalette.item.openNotes'),
      onSelect: run(openNotes),
    },
    {
      id: 'open-todos',
      secondary: true,
      title: t('commandPalette.item.openTodos'),
      icon: <Icon name="checkbox-circle" className="me-2 h-4 w-4" />,
      shortcutId: 'open_todos',
      searchText: t('commandPalette.item.openTodos'),
      onSelect: run(openTodos),
    },
  );
  if (!isVSCodeRuntime()) {
    list.push({
      id: 'restart-opencode',
      secondary: true,
      title: t('commandPalette.item.restartOpenCode'),
      icon: <Icon name="restart" className="me-2 h-4 w-4" />,
      shortcutId: 'restart_opencode',
      searchText: t('commandPalette.item.restartOpenCode'),
      onSelect: run(restartOpenCode(t)),
    });
  }
  list.push({
    id: 'toggle-memory-debug',
    secondary: true,
    title: t('commandPalette.item.toggleMemoryDebug'),
    icon: <Icon name="bug" className="me-2 h-4 w-4" />,
    searchText: t('commandPalette.item.toggleMemoryDebug'),
    onSelect: run(() => {
      window.dispatchEvent(new CustomEvent('openchamber:memory-debug-toggle'));
    }),
  });
  return list;
}

export function projectActionCommands(
  projectActions: ReturnType<typeof useProjectActions>,
  t: BuiltinCommandsOptions['t'],
  run: BuiltinCommandsOptions['run'],
): CommandEntry[] {
  const list: CommandEntry[] = [];
  if (projectActions?.available) {
    list.push({
      id: 'open-project-actions',
      secondary: true,
      title: t('commandPalette.item.openProjectActions'),
      icon: <Icon name="play" className="me-2 h-4 w-4" />,
      shortcutId: 'open_project_actions',
      searchText: t('commandPalette.item.openProjectActions'),
      onSelect: run(() => useUIStore.getState().setProjectActionsDialogOpen(true)),
    });
    for (const action of projectActions.actions) {
      const actionRun = projectActions.runOf(action);
      if (actionRun?.status === 'stopping') continue;
      const title = actionRun
        ? t('commandPalette.item.stopProjectAction', { name: action.name })
        : t('commandPalette.item.runProjectAction', { name: action.name });
      list.push({
        id: `project-action:${action.id}`,
        secondary: true,
        title,
        icon: <Icon name={actionRun ? 'stop' : resolveProjectActionIconName(action)} className="me-2 h-4 w-4" />,
        searchText: title,
        onSelect: run(() => {
          if (actionRun) {
            projectActions.stop(action);
            return;
          }
          projectActions.select(action);
          projectActions.run(action);
        }),
      });
    }
  }
  return list;
}
