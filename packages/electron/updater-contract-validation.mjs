import YAML, { isMap } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';

import updaterContract from './updater-contract.cjs';

const { J2K_MACOS_APP_UPDATE_CONFIG } = updaterContract;

const describeValue = (value) => (value === undefined ? '(missing)' : JSON.stringify(value));

export const parseAndValidateJ2kAppUpdateConfig = (content, { artifact = 'macOS app' } = {}) => {
  const document = YAML.parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${artifact} app-update.yml is malformed: ${document.errors[0].message}`);
  }

  if (!isMap(document.contents)) {
    throw new Error(`${artifact} app-update.yml must contain one YAML mapping`);
  }
  const parsed = document.toJS();

  const expectedKeys = Object.keys(J2K_MACOS_APP_UPDATE_CONFIG).sort();
  const actualKeys = Object.keys(parsed).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${artifact} app-update.yml fields differ from the J2K package contract: expected ${expectedKeys.join(', ')}, got ${actualKeys.join(', ') || '(none)'}`,
    );
  }

  for (const [key, expected] of Object.entries(J2K_MACOS_APP_UPDATE_CONFIG)) {
    if (parsed[key] !== expected) {
      throw new Error(
        `${artifact} app-update.yml ${key} differs from the J2K package contract: got ${describeValue(parsed[key])}`,
      );
    }
  }

  return parsed;
};

export const readAndValidateJ2kAppUpdateConfig = (resourcesPath, { artifact = 'macOS app' } = {}) => {
  try {
    return parseAndValidateJ2kAppUpdateConfig(
      fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8'),
      { artifact },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${artifact} app-update.yml is missing from Contents/Resources; electron-updater cannot download updates`);
    }
    throw error;
  }
};

export { J2K_MACOS_APP_UPDATE_CONFIG };
