import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { webPackagePaths } from '../web-package-paths.js';
import { isRecord, isString } from '../shared/object-guards.js';

const BUILD_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DEFAULT_REVISION_FILE = path.join(webPackagePaths.dist, 'build-revision.json');
const revisionFileSchema = z.object({ revision: z.string() });

export const readRuntimePackageVersion = (packagePath = webPackagePaths.packageJson) => {
  try {
    const raw = fs.readFileSync(packagePath, 'utf8');
    const pkg: unknown = JSON.parse(raw);
    if (isRecord(pkg) && isString(pkg.version) && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
};

export const isValidBuildRevision = (value: unknown): value is string => (
  typeof value === 'string' && BUILD_REVISION_PATTERN.test(value)
);

export const resolveBuildRevision = ({ envRevision, gitRevision, packageVersion }: {
  envRevision?: string;
  gitRevision?: string;
  packageVersion?: string;
}) => {
  if (isValidBuildRevision(envRevision)) return envRevision;
  if (isValidBuildRevision(gitRevision)) return gitRevision;
  if (isValidBuildRevision(packageVersion)) return packageVersion;
  return 'unknown';
};

export const resolveRuntimeBuildRevision = ({
  env = process.env,
  revisionFilePath = DEFAULT_REVISION_FILE,
  packageVersion,
}: { env?: NodeJS.ProcessEnv; revisionFilePath?: string; packageVersion?: string } = {}) => {
  if (isValidBuildRevision(env.OPENCHAMBER_BUILD_REVISION)) {
    return env.OPENCHAMBER_BUILD_REVISION;
  }

  try {
    const parsed = revisionFileSchema.safeParse(JSON.parse(fs.readFileSync(revisionFilePath, 'utf8')));
    if (parsed.success && isValidBuildRevision(parsed.data.revision)) return parsed.data.revision;
  } catch {
    void 0;
  }

  return resolveBuildRevision(packageVersion === undefined ? {} : { packageVersion });
};
