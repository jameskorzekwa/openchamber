const BUILD_RELOAD_GUARD_KEY = 'openchamber.build-reload-revision';

export const shouldReloadForBuildRevision = (
  serverRevision: string,
  clientRevision: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): boolean => {
  if (!serverRevision || !clientRevision || serverRevision === clientRevision) return false;
  if (storage.getItem(BUILD_RELOAD_GUARD_KEY) === serverRevision) return false;
  storage.setItem(BUILD_RELOAD_GUARD_KEY, serverRevision);
  return true;
};
