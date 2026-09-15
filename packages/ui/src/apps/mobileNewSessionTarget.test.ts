import { describe, expect, test } from 'bun:test';

import type { ProjectEntry } from '@/lib/api/types';
import type { NewSessionDraftState } from '@/sync/session-ui-store';

import { openDeepLinkNewSessionDraft, openMobileNewChatDraft } from './mobileNewSessionTarget';

const projects: ProjectEntry[] = [
  { id: 'project-a', path: '/workspace/project-a', label: 'Project A' },
  { id: 'project-b', path: 'c:\\workspace\\project-b\\', label: 'Project B' },
];

type DraftOptions = Partial<NewSessionDraftState>;

const captureDraftOpens = () => {
  const calls: Array<DraftOptions | undefined> = [];
  return {
    calls,
    openDraft: (options?: DraftOptions): void => {
      calls.push(options);
    },
  };
};

describe('mobile new-session targeting', () => {
  test('opens New Chat against the active valid project in one draft transition', () => {
    const { calls, openDraft } = captureDraftOpens();

    openMobileNewChatDraft(projects, 'project-b', openDraft);

    expect(calls).toEqual([{
      target: 'project',
      selectedProjectId: 'project-b',
      directoryOverride: 'C:/workspace/project-b',
    }]);
  });

  test('keeps New Chat projectless when the active project is stale', () => {
    const { calls, openDraft } = captureDraftOpens();

    openMobileNewChatDraft(projects, 'removed-project', openDraft);

    expect(calls).toEqual([undefined]);
  });

  test('keeps New Chat projectless when the active project path is empty', () => {
    const { calls, openDraft } = captureDraftOpens();

    openMobileNewChatDraft([{ id: 'invalid', path: '', label: 'Invalid' }], 'invalid', openDraft);

    expect(calls).toEqual([undefined]);
  });

  test('opens a project deep link atomically using the registered project path', () => {
    const { calls, openDraft } = captureDraftOpens();

    openDeepLinkNewSessionDraft({ type: 'new-session', projectId: 'project-b' }, projects, openDraft);

    expect(calls).toEqual([{
      target: 'project',
      selectedProjectId: 'project-b',
      directoryOverride: 'C:/workspace/project-b',
    }]);
  });

  test('normalizes an explicit deep-link directory in the same draft transition', () => {
    const { calls, openDraft } = captureDraftOpens();

    openDeepLinkNewSessionDraft(
      { type: 'new-session', projectId: 'project-a', directory: '/workspace/project-a/worktree/' },
      projects,
      openDraft,
    );

    expect(calls).toEqual([{
      target: 'project',
      selectedProjectId: 'project-a',
      directoryOverride: '/workspace/project-a/worktree',
    }]);
  });

  test('retains the global projectless Chat default for an untargeted deep link', () => {
    const { calls, openDraft } = captureDraftOpens();

    openDeepLinkNewSessionDraft({ type: 'new-session' }, projects, openDraft);

    expect(calls).toEqual([undefined]);
  });
});
