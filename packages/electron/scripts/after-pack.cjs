const fs = require('node:fs');
const path = require('node:path');

// YAML serialization for app-update.yml configuration. Simple implementation
// sufficient for the publish config structure (flat object with string values).
const serializeToYaml = (object) => {
  const lines = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) continue;
    // Quote strings that contain special YAML characters
    const needsQuoting = typeof value === 'string' && /[:#{}[\],&*!|>'"%@`]/.test(value);
    const formatted = needsQuoting ? `'${value.replace(/'/g, "''")}'` : String(value);
    lines.push(`${key}: ${formatted}`);
  }
  return lines.join('\n') + '\n';
};

// Resolve the updater feed configuration for the build. Mirrors the logic in
// updater-feed.mjs but for the after-pack CommonJS context.
const resolveAppUpdateConfig = ({ j2kBuild, platform }) => {
  // For J2K macOS builds, use the private generic feed
  if (platform === 'darwin' && j2kBuild) {
    return {
      provider: 'generic',
      url: 'https://raw.githubusercontent.com/jameskorzekwa/openchamber/desktop-channel/',
      updaterCacheDirName: 'openchamber-updater',
    };
  }
  // Default GitHub releases feed for other builds
  return {
    provider: 'github',
    owner: 'openchamber',
    repo: 'openchamber',
    updaterCacheDirName: 'openchamber-updater',
  };
};

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));

  // Generate and write app-update.yml for electron-updater. This file tells
  // the updater where to check for updates. Without it, the download step
  // fails with ENOENT when the user clicks "Download Update".
  const j2kBuild = process.env.OPENCHAMBER_J2K_DESKTOP_BUILD === '1';
  const appUpdateConfig = resolveAppUpdateConfig({
    j2kBuild,
    platform: context.electronPlatformName,
  });
  const appUpdateYml = serializeToYaml(appUpdateConfig);
  fs.writeFileSync(path.join(resourcesPath, 'app-update.yml'), appUpdateYml, 'utf8');
};
