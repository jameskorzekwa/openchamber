import YAML, { isMap } from 'yaml';
import fs from 'node:fs';
import path from 'node:path';

import updaterContract from './updater-contract.cjs';

const { J2K_MACOS_APP_UPDATE_CONFIG } = updaterContract;

export const parseAndValidateJ2kAppUpdateConfig = (content, { artifact = 'macOS app' } = {}) => {
  let document;
  try {
    document = YAML.parseDocument(content, { uniqueKeys: true });
  } catch {
    throw new Error(`${artifact} app-update.yml is malformed`);
  }
  if (document.errors.length > 0) {
    throw new Error(`${artifact} app-update.yml is malformed`);
  }

  if (!isMap(document.contents)) {
    throw new Error(`${artifact} app-update.yml must contain one YAML mapping`);
  }

  let parsed;
  try {
    parsed = document.toJS();
  } catch {
    throw new Error(`${artifact} app-update.yml is malformed`);
  }

  const expectedKeys = Object.keys(J2K_MACOS_APP_UPDATE_CONFIG).sort();
  const missingKeys = expectedKeys.filter((key) => !Object.hasOwn(parsed, key));
  const unexpectedFieldCount = Object.keys(parsed)
    .filter((key) => !Object.hasOwn(J2K_MACOS_APP_UPDATE_CONFIG, key)).length;
  if (missingKeys.length > 0 || unexpectedFieldCount > 0) {
    const differences = [];
    if (missingKeys.length > 0) differences.push(`missing known fields: ${missingKeys.join(', ')}`);
    if (unexpectedFieldCount > 0) differences.push(`unexpected field count: ${unexpectedFieldCount}`);
    throw new Error(
      `${artifact} app-update.yml fields differ from the J2K package contract (${differences.join('; ')})`,
    );
  }

  for (const [key, expected] of Object.entries(J2K_MACOS_APP_UPDATE_CONFIG)) {
    if (parsed[key] !== expected) {
      throw new Error(`${artifact} app-update.yml ${key} differs from the J2K package contract`);
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
