import type { ProjectEntry } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import type { NewSessionDraftState } from '@/sync/session-ui-store';

import type { DeepLinkIntent } from './deepLinks';

type OpenNewSessionDraft = (options?: Partial<NewSessionDraftState>) => void;

const getProjectDraftOptions = (
  project: Pick<ProjectEntry, 'id' | 'path'>,
): Partial<NewSessionDraftState> | undefined => {
  const directoryOverride = normalizePath(project.path);
  if (!directoryOverride) return undefined;

  return {
    target: 'project',
    selectedProjectId: project.id,
    directoryOverride,
  };
};

export const openMobileNewChatDraft = (
  projects: ProjectEntry[],
  activeProjectId: string | null,
  openNewSessionDraft: OpenNewSessionDraft,
): void => {
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : undefined;
  const draftOptions = activeProject ? getProjectDraftOptions(activeProject) : undefined;

  if (draftOptions) {
    openNewSessionDraft(draftOptions);
  } else {
    openNewSessionDraft();
  }
};

export const openDeepLinkNewSessionDraft = (
  intent: Extract<DeepLinkIntent, { type: 'new-session' }>,
  projects: ProjectEntry[],
  openNewSessionDraft: OpenNewSessionDraft,
): void => {
  const project = intent.projectId
    ? projects.find((candidate) => candidate.id === intent.projectId)
    : undefined;
  const directoryOverride = normalizePath(intent.directory ?? project?.path);

  if (!directoryOverride) {
    openNewSessionDraft();
    return;
  }

  openNewSessionDraft({
    target: 'project',
    selectedProjectId: project?.id ?? null,
    directoryOverride,
  });
};
