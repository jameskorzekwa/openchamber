import { resolveGitCommonDirectory, watchWorktreeChanges } from './worktree-change-watcher.js';

export function createWorktreeRefreshRegistry({
  emitSessionCreatedEvent,
  globalEventHub,
  watch = watchWorktreeChanges,
  resolveCommonDirectory = resolveGitCommonDirectory,
  maxWatchers = 50,
  maxSessions = 2000,
} = {}) {
  const watchers = new Map();
  const directoryKeys = new Map();
  const sessionDirectories = new Map();
  const normalizeKey = (value) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const emitRefresh = (directory) => {
    try {
      emitSessionCreatedEvent({
        sessionID: 'worktree-topology-refresh',
        directory,
        createdAt: Date.now(),
        promptDispatched: false,
        dispatchedAsCommand: false,
      });
    } catch (error) {
      console.warn('Failed to emit worktree refresh event:', error?.message || error);
    }
  };
  const dispose = (key) => {
    const entry = watchers.get(key);
    watchers.delete(key);
    for (const [directory, commonDirectory] of directoryKeys) {
      if (commonDirectory === key) directoryKeys.delete(directory);
    }
    try { entry?.unsubscribe?.(); } catch {}
  };
  const ensure = async (directory) => {
    if (typeof emitSessionCreatedEvent !== 'function') return;
    if (typeof directory !== 'string' || !directory.trim()) return;
    const requestedDirectory = normalizeKey(directory);
    let key = directoryKeys.get(requestedDirectory);
    if (!key) {
      try {
        key = normalizeKey(await resolveCommonDirectory(requestedDirectory));
        directoryKeys.set(requestedDirectory, key);
      } catch (error) {
        console.warn('Failed to resolve worktree metadata:', error?.message || error);
        return;
      }
    }
    const existing = watchers.get(key);
    if (existing) {
      existing.directories.add(requestedDirectory);
      watchers.delete(key);
      watchers.set(key, existing);
      return;
    }
    const entry = { directories: new Set([requestedDirectory]), unsubscribe: null };
    watchers.set(key, entry);
    while (watchers.size > maxWatchers) dispose(watchers.keys().next().value);
    try {
      const unsubscribe = await watch(requestedDirectory, () => {
        for (const observedDirectory of entry.directories) emitRefresh(observedDirectory);
      });
      if (watchers.get(key) !== entry) return unsubscribe();
      entry.unsubscribe = unsubscribe;
    } catch (error) {
      if (watchers.get(key) === entry) watchers.delete(key);
      console.warn('Failed to watch worktree metadata:', error?.message || error);
    }
  };
  const unsubscribeGlobal = globalEventHub?.subscribeEvent?.((event) => {
    const raw = event?.payload;
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'session.deleted') {
      const sessionID = payload.properties?.sessionID ?? payload.properties?.info?.id;
      if (typeof sessionID === 'string') sessionDirectories.delete(sessionID);
      return;
    }
    if (payload.type !== 'session.created' && payload.type !== 'session.updated') return;
    const info = payload.properties?.info;
    const sessionID = typeof info?.id === 'string' ? info.id : '';
    const directory = typeof info?.directory === 'string' && info.directory.trim()
      ? normalizeKey(info.directory)
      : (typeof event?.directory === 'string' && event.directory !== 'global' ? normalizeKey(event.directory) : '');
    if (!sessionID || !directory) return;
    const previous = sessionDirectories.get(sessionID);
    sessionDirectories.delete(sessionID);
    sessionDirectories.set(sessionID, directory);
    while (sessionDirectories.size > maxSessions) sessionDirectories.delete(sessionDirectories.keys().next().value);
    void ensure(directory);
    if (payload.type === 'session.updated' && !previous) {
      emitRefresh(directory);
    } else if (previous && previous !== directory) {
      emitRefresh(previous);
      emitRefresh(directory);
    }
  });
  const close = () => {
    try { unsubscribeGlobal?.(); } catch {}
    Array.from(watchers.keys()).forEach(dispose);
    sessionDirectories.clear();
  };
  return { ensure, close };
}
