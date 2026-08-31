import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DEFAULT_REVISION_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'dist',
  'build-revision.json',
);

export const isValidBuildRevision = (value) => (
  String(value) === value && BUILD_REVISION_PATTERN.test(value)
);

export const resolveBuildRevision = ({ envRevision, gitRevision, packageVersion }) => {
  if (isValidBuildRevision(envRevision)) return envRevision;
  if (isValidBuildRevision(gitRevision)) return gitRevision;
  if (isValidBuildRevision(packageVersion)) return packageVersion;
  return 'unknown';
};

export const resolveRuntimeBuildRevision = ({
  env = process.env,
  revisionFilePath = DEFAULT_REVISION_FILE,
  packageVersion,
} = {}) => {
  if (isValidBuildRevision(env.OPENCHAMBER_BUILD_REVISION)) {
    return env.OPENCHAMBER_BUILD_REVISION;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(revisionFilePath, 'utf8'));
    if (isValidBuildRevision(parsed?.revision)) return parsed.revision;
  } catch {
  }

  return resolveBuildRevision({ packageVersion });
};
