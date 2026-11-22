import { resolveUpdaterChannel } from './updater-channel.mjs';
import {
  CANARY_MIRROR_UPDATER_FEED,
  CANARY_UPDATER_FEED,
  PRODUCTION_UPDATER_FEED,
  STABLE_MIRROR_UPDATER_FEED,
  isCanaryVersion,
  pickUpdaterSource,
  resolveUpdaterFeed,
} from './updater-feed.mjs';

export const createUpdaterChannelApplier = ({
  autoUpdater,
  state,
  appVersion,
  platform,
  architecture,
  testBuild,
  j2kBuild,
  log,
  onChannelSwitch = () => {},
}) => (channel, source = pickUpdaterSource({ mirrorFailedAt: state.updaterMirrorFailedAt })) => {
  if (state.updaterChannel === channel && state.updaterSource === source) return;
  if (state.updaterChannel !== null && state.updaterChannel !== channel) {
    state.pendingUpdate = null;
    onChannelSwitch();
  }
  const feed = resolveUpdaterFeed({ testBuild, channel, source, j2kBuild, platform });
  const updaterChannel = [PRODUCTION_UPDATER_FEED, CANARY_UPDATER_FEED, STABLE_MIRROR_UPDATER_FEED, CANARY_MIRROR_UPDATER_FEED].includes(feed)
    ? resolveUpdaterChannel({ platform, architecture })
    : null;
  if (updaterChannel) {
    autoUpdater.channel = updaterChannel;
  }
  autoUpdater.setFeedURL(feed);
  autoUpdater.allowDowngrade = channel === 'stable' && isCanaryVersion(appVersion);
  state.updaterChannel = channel;
  state.updaterSource = source;
  log.info('[electron] updater feed configured', {
    channel,
    source,
    provider: feed.provider,
    target: feed.provider === 'github' ? `${feed.owner}/${feed.repo}` : feed.url,
    manifest: updaterChannel || 'latest',
    allowDowngrade: autoUpdater.allowDowngrade,
  });
};
