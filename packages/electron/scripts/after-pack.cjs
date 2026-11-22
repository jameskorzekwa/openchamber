const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('electron-builder');
const { setExecutableUuid } = require('./macos-executable-uuid.cjs');
const { verifyPackagedAppContents } = require('./packaged-app-contents.cjs');
const {
  DEFAULT_APP_UPDATE_CONFIG,
  J2K_MACOS_APP_UPDATE_CONFIG,
} = require('../updater-contract.cjs');

const serializeToYaml = (object) => {
  const lines = [];
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined) continue;
    const needsQuoting = /[:#{}[\],&*!|>'"%@`]/.test(value);
    const formatted = needsQuoting ? `'${value.replace(/'/g, "''")}'` : String(value);
    lines.push(`${key}: ${formatted}`);
  }
  return lines.join('\n') + '\n';
};

const resolveAppUpdateConfig = ({ j2kBuild, platform }) => {
  if (platform === 'darwin' && j2kBuild) {
    return J2K_MACOS_APP_UPDATE_CONFIG;
  }
  return DEFAULT_APP_UPDATE_CONFIG;
};

const writeAppUpdateConfig = ({ resourcesPath, platform, j2kBuild }) => {
  const appUpdateYml = serializeToYaml(resolveAppUpdateConfig({ j2kBuild, platform }));
  fs.writeFileSync(path.join(resourcesPath, 'app-update.yml'), appUpdateYml, 'utf8');
};

const afterPack = (context) => {
  const { appInfo } = context.packager;
  const contentsPath = path.join(context.appOutDir, `${appInfo.productFilename}.app`, 'Contents');
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(contentsPath, 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyPackagedAppContents(resourcesPath, { platform: context.electronPlatformName, arch: Arch[context.arch] });
  if (context.electronPlatformName !== 'darwin') return;

  const executablePath = path.join(contentsPath, 'MacOS', appInfo.productFilename);
  setExecutableUuid(executablePath, appInfo.id);
  if (context.arch === Arch.arm64) {
    execFileSync('codesign', ['--force', '--sign', '-', executablePath], { stdio: 'inherit' });
  }

  const iconsDir = process.env.OPENCHAMBER_DESKTOP_CHANNEL === 'canary' ? 'icons-canary' : 'icons';
  const sourceAssetsPath = path.join(__dirname, '..', 'resources', iconsDir, 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));

  writeAppUpdateConfig({
    resourcesPath,
    platform: context.electronPlatformName,
    j2kBuild: process.env.OPENCHAMBER_J2K_DESKTOP_BUILD === '1',
  });
};

module.exports = afterPack;
module.exports.writeAppUpdateConfig = writeAppUpdateConfig;
