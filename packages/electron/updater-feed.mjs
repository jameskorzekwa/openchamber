import fs from 'node:fs';
import updaterContract from './updater-contract.cjs';

export const {
  DEFAULT_APP_UPDATE_CONFIG,
  J2K_MACOS_APP_UPDATE_CONFIG,
} = updaterContract;

export const MACOS_PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: J2K_MACOS_APP_UPDATE_CONFIG.provider,
  url: J2K_MACOS_APP_UPDATE_CONFIG.url,
});

export const DEFAULT_PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: DEFAULT_APP_UPDATE_CONFIG.provider,
  owner: DEFAULT_APP_UPDATE_CONFIG.owner,
  repo: DEFAULT_APP_UPDATE_CONFIG.repo,
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
