export type RemoteRepositoryApi = {
  repositoryOfRemote: typeof repositoryOfRemote;
};

export const repositoryOfRemote = (raw: string, instance: string): { owner: string; name: string } | null => {
  const origin = new URL(instance);
  let host: string;
  let path: string;
  const scp = raw.includes('://') ? null : raw.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
    if (host !== origin.hostname.toLowerCase()) return null;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    if (web && url.host.toLowerCase() !== origin.host.toLowerCase()) return null;
    if (!web && url.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return null;
    path = decodeURIComponent(url.pathname);
  }
  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return null;
  return { owner: segments[0], name: segments[1] };
};
