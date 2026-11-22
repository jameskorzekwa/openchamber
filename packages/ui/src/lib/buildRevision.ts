const BUILD_RELOAD_GUARD_KEY = 'openchamber.build-reload-revision';
const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

const isValidBuildRevision = (value: string): boolean => BUILD_REVISION_PATTERN.test(value);

export const shouldReloadForBuildRevision = (
  serverRevision: string,
  clientRevision: string,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
): boolean => {
  if (!isValidBuildRevision(serverRevision) || !isValidBuildRevision(clientRevision) || serverRevision === clientRevision) return false;
  if (storage.getItem(BUILD_RELOAD_GUARD_KEY) === serverRevision) return false;
  storage.setItem(BUILD_RELOAD_GUARD_KEY, serverRevision);
  return true;
};
