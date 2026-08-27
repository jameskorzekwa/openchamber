import fs from 'node:fs';

export const DEFAULT_PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'github',
  owner: 'openchamber',
  repo: 'openchamber',
});

export const MACOS_PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://raw.githubusercontent.com/jameskorzekwa/openchamber/desktop-channel/',
});

export const resolveProductionUpdaterFeed = ({ platform = process.platform, j2kBuild = false } = {}) => (
  platform === 'darwin' && j2kBuild ? MACOS_PRODUCTION_UPDATER_FEED : DEFAULT_PRODUCTION_UPDATER_FEED
);

export const resolveUpdaterPrereleasePolicy = ({ platform = process.platform, j2kBuild = false } = {}) => (
  platform === 'darwin' && j2kBuild
);

const isLoopbackHostname = (hostname) => {
  if (hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value <= 255);
};

export const parseLoopbackUpdaterUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveUpdaterFeed = ({
  environment = process.env,
  j2kBuild = false,
  platform = process.platform,
  testBuild = false,
} = {}) => {
  const productionFeed = resolveProductionUpdaterFeed({ platform, j2kBuild });
  if (environment.OPENCHAMBER_E2E !== '1'
    || testBuild !== true) {
    return productionFeed;
  }

  const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
  if (!url) return productionFeed;
  return { provider: 'generic', url };
};
