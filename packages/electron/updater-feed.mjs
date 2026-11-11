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

// Upstream's name for the public release feed.
export const PRODUCTION_UPDATER_FEED = DEFAULT_PRODUCTION_UPDATER_FEED;

// Canary builds replace the files of one pre-release, tagged `canary`, every
// night. The GitHub provider reads only the latest full release, so the
// Canary channel reads that pre-release's files directly, and the Stable
// channel never sees them.
export const CANARY_UPDATER_FEED = Object.freeze({
  provider: 'generic',
  url: 'https://github.com/openchamber/openchamber/releases/download/canary/',
});

// Where the app takes its updates from: the releases, or the nightly Canary
// build. The person picks it in Settings → About; the app installs the next
// update from that channel and keeps following it. Without a pick (unset, an
// older build's value) the app follows its own build, so a Canary build
// installed from the canary pre-release does not offer the older release as
// an update nobody asked for.
export const isUpdateChannel = (value) => value === 'stable' || value === 'canary';

// A Canary build's version is the release it leads to with a `canary`
// pre-release part: 2.5.4-canary.20261030.123.
export const isCanaryVersion = (version) => /-canary\./.test(String(version ?? ''));

export const normalizeUpdateChannel = (value, appVersion) => {
  if (isUpdateChannel(value)) return value;
  return isCanaryVersion(appVersion) ? 'canary' : 'stable';
};

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
  channel = 'stable',
} = {}) => {
  // A J2K macOS build follows the fork's private desktop channel only; the
  // upstream Stable/Canary choice applies to every other build.
  const productionFeed = platform === 'darwin' && j2kBuild
    ? MACOS_PRODUCTION_UPDATER_FEED
    : (channel === 'canary' ? CANARY_UPDATER_FEED : DEFAULT_PRODUCTION_UPDATER_FEED);
  if (environment.OPENCHAMBER_E2E !== '1'
    || testBuild !== true) {
    return productionFeed;
  }

  const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
  if (!url) return productionFeed;
  return { provider: 'generic', url };
};
