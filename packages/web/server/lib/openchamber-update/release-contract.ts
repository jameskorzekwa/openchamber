export interface Target { platform: string; arch: string; nodeAbi: string }
export interface ReleaseAsset { name: string; url: string; size: number }
export interface Release { tag: string; targetCommitish: string; assets: ReleaseAsset[] }
export interface Artifact extends Target { tarball: string; sha256: string }
export interface Channel extends Target {
  schema: number;
  channel: string;
  repository: string;
  baseVersion: string;
  channelRevision: number;
  releaseTag: string;
  version: string;
  upstreamTag: string;
  seriesHead: string;
  sourceCommit: string;
  minNode: string;
  assets: string[];
  artifacts?: Artifact[];
  archive: { name: string; checksumName: string; sha256: string };
}
export const hasErrorCode = (value: unknown): value is { code: string } =>
  value !== null && typeof value === 'object' && 'code' in value && typeof value.code === 'string';

export function fail(message: string): never {
  throw new Error(message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value === Object(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export const isString = (value: unknown): value is string => String(value) === value;
export function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
