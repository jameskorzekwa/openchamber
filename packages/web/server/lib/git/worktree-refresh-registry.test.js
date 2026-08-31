import { describe, expect, it, vi } from 'vitest';
import { createWorktreeRefreshRegistry } from './worktree-refresh-registry.js';

const createGlobalEventHub = () => {
  let subscriber = null;
  const unsubscribe = vi.fn();
  return {
    hub: {
      subscribeEvent(next) {
        subscriber = next;
        return unsubscribe;
      },
    },
    emit(payload, directory = 'global') {
      subscriber?.({ payload, directory });
    },
    unsubscribe,
  };
};

describe('createWorktreeRefreshRegistry', () => {
  it('shares one watcher across checkouts in the same repository', async () => {
    const watched = [];
    const events = [];
    let callback;
    const close = vi.fn();
    const registry = createWorktreeRefreshRegistry({
      emitSessionCreatedEvent: (event) => events.push(event),
      resolveCommonDirectory: async () => '/repo/.git',
      watch: async (directory, onChange) => {
        watched.push(directory);
        callback = onChange;
        return close;
      },
    });

    await Promise.all([registry.ensure('/repo'), registry.ensure('/tmp/repo-worktree')]);
    callback();

    expect(watched).toEqual(['/repo']);
    expect(events.map((event) => event.directory).sort()).toEqual(['/repo', '/tmp/repo-worktree']);
    registry.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('refreshes old and new topology after an authoritative session move', async () => {
    const globalEvents = createGlobalEventHub();
    const events = [];
    const registry = createWorktreeRefreshRegistry({
      emitSessionCreatedEvent: (event) => events.push(event),
      globalEventHub: globalEvents.hub,
      resolveCommonDirectory: async () => '/repo/.git',
      watch: async () => () => {},
    });

    globalEvents.emit({
      type: 'session.updated',
      properties: { info: { id: 'ses_move', directory: '/repo' } },
    }, '/repo');
    await new Promise((resolve) => setImmediate(resolve));
    globalEvents.emit({
      type: 'session.updated',
      properties: { info: { id: 'ses_move', directory: '/tmp/repo-worktree' } },
    }, '/tmp/repo-worktree');
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.map((event) => event.directory)).toEqual([
      '/repo',
      '/repo',
      '/tmp/repo-worktree',
    ]);
    registry.close();
    expect(globalEvents.unsubscribe).toHaveBeenCalledOnce();
  });

  it('evicts the least recently used watcher at the configured bound', async () => {
    const closed = [];
    const registry = createWorktreeRefreshRegistry({
      maxWatchers: 2,
      emitSessionCreatedEvent: () => {},
      resolveCommonDirectory: async (directory) => `${directory}/.git`,
      watch: async (directory) => () => closed.push(directory),
    });

    await registry.ensure('/one');
    await registry.ensure('/two');
    await registry.ensure('/one');
    await registry.ensure('/three');

    expect(closed).toEqual(['/two']);
    registry.close();
    expect(new Set(closed)).toEqual(new Set(['/one', '/two', '/three']));
  });
});
