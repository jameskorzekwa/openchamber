const UPDATER_CACHE_DIR_NAME = 'openchamber-updater';

const DEFAULT_APP_UPDATE_CONFIG = Object.freeze({
  provider: 'github',
  owner: 'openchamber',
  repo: 'openchamber',
  updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
});

const J2K_MACOS_APP_UPDATE_CONFIG = Object.freeze({
  provider: 'generic',
  url: 'https://raw.githubusercontent.com/jameskorzekwa/openchamber/desktop-channel/',
  updaterCacheDirName: UPDATER_CACHE_DIR_NAME,
});

module.exports = {
  DEFAULT_APP_UPDATE_CONFIG,
  J2K_MACOS_APP_UPDATE_CONFIG,
};
