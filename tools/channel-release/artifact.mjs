import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { createGzip, gunzipSync } from 'node:zlib';

export const ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  entries: 50_000,
  metadataBytes: 64 * 1024,
});

const BLOCK_SIZE = 512;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const REQUIRED_PATHS = [
  'package/package.json',
  'package/bin/cli.js',
  'package/server/index.js',
  'package/dist/index.html',
  'package/dist/build-revision.json',
  'package/node_modules/',
];

function fail(message) {
  throw new Error(message);
}

export function validateArtifactTarget(target) {
  if (!target || !/^[a-z0-9_-]+$/.test(target.platform || '') || !/^[a-z0-9_-]+$/.test(target.arch || '') || !/^[1-9]\d*$/.test(target.nodeAbi || '')) {
    fail('Artifact target requires valid platform, arch, and Node ABI strings');
  }
  return { platform: target.platform, arch: target.arch, nodeAbi: target.nodeAbi };
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function packageSegments(name) {
  if (!PACKAGE_NAME_PATTERN.test(name)) fail(`Invalid dependency name: ${name}`);
  return name.split('/');
}

function readPackageJson(directory, label = directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch {
    fail(`Missing or malformed package.json: ${label}`);
  }
}

function dependencySets(packageJson) {
  const required = new Set(Object.keys(packageJson.dependencies || {}));
  const optional = new Set(Object.keys(packageJson.optionalDependencies || {}));
  for (const name of Object.keys(packageJson.peerDependencies || {})) {
    if (packageJson.peerDependenciesMeta?.[name]?.optional === true) optional.add(name);
    else required.add(name);
  }
  for (const name of optional) required.delete(name);
  return { required: [...required].sort(), optional: [...optional].sort() };
}

function findInstalledDependency(packageDirectory, name, repositoryRoot) {
  let current = packageDirectory;
  const segments = packageSegments(name);
  while (true) {
    const candidate = join(current, 'node_modules', ...segments);
    if (existsSync(candidate)) {
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isDirectory()) fail(`Installed dependency is not a directory: ${name}`);
      if (!isInside(join(repositoryRoot, 'node_modules'), resolved)) {
        fail(`Installed dependency resolves outside the frozen node_modules tree: ${name}`);
      }
      return resolved;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function copyMaterialized(source, destination, active = new Set()) {
  if (lstatSync(source).isSymbolicLink()) fail(`Package contains a symlink outside omitted node_modules/.bin: ${source}`);
  const realSource = realpathSync(source);
  if (active.has(realSource)) fail(`Symlink cycle while materializing ${source}`);
  const sourceStat = statSync(realSource);
  if (sourceStat.isDirectory()) {
    active.add(realSource);
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const name of readdirSync(realSource).sort()) {
      if (name === 'node_modules' || name === '.bin') continue;
      copyMaterialized(join(realSource, name), join(destination, name), active);
    }
    active.delete(realSource);
    return;
  }
  if (!sourceStat.isFile()) fail(`Package contains an unsupported special entry: ${source}`);
  if (sourceStat.size > ARCHIVE_LIMITS.fileBytes) fail(`Package file exceeds 128 MiB: ${source}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(realSource, destination);
  chmodSync(destination, (sourceStat.mode & 0o111) !== 0 ? 0o755 : 0o644);
}

function findPlacedDependency(packageTarget, name, stagingRoot, placements) {
  let current = packageTarget;
  const segments = packageSegments(name);
  while (isInside(stagingRoot, current)) {
    const candidate = join(current, 'node_modules', ...segments);
    if (placements.has(candidate)) return { target: candidate, source: placements.get(candidate) };
    if (current === stagingRoot) break;
    current = dirname(current);
  }
  return null;
}

function placeDependency(source, parentTarget, name, stagingRoot, placements, pending) {
  const existing = findPlacedDependency(parentTarget, name, stagingRoot, placements);
  if (existing?.source === source) return;

  const rootTarget = join(stagingRoot, 'node_modules', ...packageSegments(name));
  let target = rootTarget;
  if (placements.has(rootTarget) && placements.get(rootTarget) !== source) {
    target = join(parentTarget, 'node_modules', ...packageSegments(name));
  }
  if (placements.has(target)) {
    if (placements.get(target) !== source) fail(`Dependency placement conflict for ${name}`);
    return;
  }

  copyMaterialized(source, target);
  const stagedPackage = readPackageJson(target, name);
  if (stagedPackage.name !== name) fail(`Resolved dependency ${name} contains package ${stagedPackage.name || '<unnamed>'}`);
  placements.set(target, source);
  pending.push({ source, target });
}

export function stageRelocatablePackage({ repositoryRoot, packageRoot, stagingRoot, sourceCommit, target }) {
  repositoryRoot = realpathSync(repositoryRoot);
  packageRoot = realpathSync(packageRoot);
  target = validateArtifactTarget(target);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail(`Invalid source commit: ${sourceCommit}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true, mode: 0o755 });

  for (const name of ['dist', 'server', 'bin', 'public', 'package.json', 'README.md']) {
    const source = join(packageRoot, name);
    if (!existsSync(source)) fail(`Release package is missing ${name}`);
    copyMaterialized(source, join(stagingRoot, name));
  }
  writeFileSync(join(stagingRoot, 'dist', 'build-revision.json'), `${JSON.stringify({ revision: sourceCommit }, null, 2)}\n`, { mode: 0o644 });
  const stagedPackageJson = readPackageJson(stagingRoot);
  stagedPackageJson.openchamberArtifact = target;
  writeFileSync(join(stagingRoot, 'package.json'), `${JSON.stringify(stagedPackageJson, null, 2)}\n`, { mode: 0o644 });
  mkdirSync(join(stagingRoot, 'node_modules'), { recursive: true, mode: 0o755 });

  const placements = new Map();
  const pending = [{ source: packageRoot, target: stagingRoot }];
  while (pending.length > 0) {
    const current = pending.pop();
    const packageJson = readPackageJson(current.source);
    const dependencies = dependencySets(packageJson);
    for (const name of dependencies.required) {
      const source = findInstalledDependency(current.source, name, repositoryRoot);
      if (!source) fail(`Missing required production dependency ${name} for ${packageJson.name}`);
      placeDependency(source, current.target, name, stagingRoot, placements, pending);
    }
    for (const name of dependencies.optional) {
      const source = findInstalledDependency(current.source, name, repositoryRoot);
      if (source) placeDependency(source, current.target, name, stagingRoot, placements, pending);
    }
  }
  return { packages: placements.size + 1 };
}

function collectEntries(packageDirectory) {
  const entries = [{ archivePath: 'package/', source: packageDirectory, type: '5', size: 0, mode: 0o755 }];
  const walk = (directory, archiveDirectory) => {
    for (const name of readdirSync(directory).sort()) {
      const source = join(directory, name);
      const stat = lstatSync(source);
      const archivePath = `${archiveDirectory}${name}`;
      if (stat.isSymbolicLink()) fail(`Staged package contains a symlink: ${archivePath}`);
      if (stat.isDirectory()) {
        entries.push({ archivePath: `${archivePath}/`, source, type: '5', size: 0, mode: 0o755 });
        walk(source, `${archivePath}/`);
      } else if (stat.isFile()) {
        if (stat.size > ARCHIVE_LIMITS.fileBytes) fail(`Staged file exceeds 128 MiB: ${archivePath}`);
        entries.push({ archivePath, source, type: '0', size: stat.size, mode: (stat.mode & 0o111) !== 0 ? 0o755 : 0o644 });
      } else {
        fail(`Staged package contains a special entry: ${archivePath}`);
      }
    }
  };
  walk(packageDirectory, 'package/');
  return entries;
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) fail(`Tar header value is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) fail(`Tar number is too large: ${value}`);
  header.write(`${encoded}\0`, offset, length, 'ascii');
}

function tarHeader(name, { mode, size, type }) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, 'ascii');
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function paxPathRecord(path) {
  const body = `path=${path}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  const record = Buffer.from(`${length} ${body}`);
  if (record.length > ARCHIVE_LIMITS.metadataBytes) fail(`Path requires excessive PAX metadata: ${path}`);
  return record;
}

async function writeChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

export async function createRelocatableArchive(packageDirectory, archivePath) {
  const entries = collectEntries(packageDirectory);
  const metadataCount = entries.filter((entry) => Buffer.byteLength(entry.archivePath) > 100).length;
  if (entries.length + metadataCount > ARCHIVE_LIMITS.entries) fail('Archive would contain more than 50,000 entries');

  mkdirSync(dirname(archivePath), { recursive: true });
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o644 });
  const gzip = createGzip({ level: 9, mtime: 0 });
  gzip.pipe(output);
  let expandedBytes = 0;
  let entryIndex = 0;
  const writeTar = async (chunk) => {
    expandedBytes += chunk.length;
    if (expandedBytes > ARCHIVE_LIMITS.expandedBytes) fail('Archive exceeds 512 MiB expanded');
    await writeChunk(gzip, chunk);
  };

  try {
    for (const entry of entries) {
      entryIndex += 1;
      let headerName = entry.archivePath;
      if (Buffer.byteLength(headerName) > 100) {
        const pax = paxPathRecord(headerName);
        const paxName = `PaxHeaders/${entryIndex}`;
        await writeTar(tarHeader(paxName, { mode: 0o644, size: pax.length, type: 'x' }));
        await writeTar(pax);
        await writeTar(Buffer.alloc((BLOCK_SIZE - (pax.length % BLOCK_SIZE)) % BLOCK_SIZE));
        headerName = `PaxEntry/${entryIndex}`;
      }
      await writeTar(tarHeader(headerName, entry));
      if (entry.type === '0') {
        for await (const chunk of createReadStream(entry.source)) await writeTar(chunk);
        await writeTar(Buffer.alloc((BLOCK_SIZE - (entry.size % BLOCK_SIZE)) % BLOCK_SIZE));
      }
    }
    await writeTar(Buffer.alloc(BLOCK_SIZE * 2));
    gzip.end();
    await once(output, 'close');
  } catch (error) {
    gzip.destroy();
    output.destroy();
    rmSync(archivePath, { force: true });
    throw error;
  }
  const compressedBytes = statSync(archivePath).size;
  if (compressedBytes > ARCHIVE_LIMITS.compressedBytes) {
    rmSync(archivePath, { force: true });
    fail('Archive exceeds 256 MiB compressed');
  }
  return { compressedBytes, expandedBytes, entries: entries.length + metadataCount };
}

function parseTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString('utf8', offset, end >= offset && end < offset + length ? end : offset + length);
}

function parseTarNumber(buffer, offset, length) {
  if ((buffer[offset] & 0x80) !== 0) fail('Base-256 tar numbers are not allowed');
  const raw = parseTarString(buffer, offset, length).trim();
  if (!/^[0-7]*$/.test(raw)) fail('Archive contains an invalid tar number');
  const value = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) fail('Archive contains an invalid tar number');
  return value;
}

function verifyTarHeader(header) {
  const stored = parseTarNumber(header, 148, 8);
  let calculated = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) calculated += index >= 148 && index < 156 ? 32 : header[index];
  if (stored !== calculated) fail('Archive contains a corrupt tar header');
}

function parsePaxPath(data) {
  let offset = 0;
  let result = null;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) fail('Archive contains malformed PAX metadata');
    const length = Number.parseInt(data.toString('ascii', offset, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length || data[offset + length - 1] !== 10) {
      fail('Archive contains malformed PAX metadata');
    }
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const separator = record.indexOf('=');
    const key = record.slice(0, separator);
    if (separator < 1 || key !== 'path' || result !== null) fail(`Archive contains unsupported PAX metadata: ${key}`);
    result = record.slice(separator + 1);
    offset += length;
  }
  return result;
}

function safePath(entryPath) {
  if (!entryPath.startsWith('package/') || entryPath.includes('\\') || entryPath.includes('\0')) fail(`Unsafe archive path: ${entryPath}`);
  const value = entryPath.slice('package/'.length).replace(/\/$/, '');
  if (!value) return '';
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`Unsafe archive path: ${entryPath}`);
  return parts.join('/');
}

function resolveArchiveDependency(packageDirectory, name, directories) {
  let current = packageDirectory;
  while (current === 'package' || current.startsWith('package/')) {
    const candidate = `${current}/node_modules/${name}`;
    if (directories.has(candidate)) return candidate;
    if (current === 'package') break;
    current = current.slice(0, current.lastIndexOf('/'));
  }
  return null;
}

function supportsTarget(values, target) {
  if (!Array.isArray(values)) return true;
  if (values.includes(`!${target}`)) return false;
  const positive = values.filter((value) => !String(value).startsWith('!'));
  return positive.length === 0 || positive.includes(target);
}

function validateDependencyClosure(files, directories, target) {
  const packageFiles = [...files.keys()].filter((name) => name === 'package/package.json' || /\/node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(name));
  for (const packageFile of packageFiles) {
    let packageJson;
    try {
      packageJson = JSON.parse(files.get(packageFile).toString('utf8'));
    } catch {
      fail(`Malformed bundled package.json: ${packageFile}`);
    }
    const packageDirectory = packageFile.slice(0, -'/package.json'.length);
    if (!supportsTarget(packageJson.os, target.platform)) fail(`Bundled dependency ${packageJson.name || packageDirectory} does not support ${target.platform}`);
    if (!supportsTarget(packageJson.cpu, target.arch)) fail(`Bundled dependency ${packageJson.name || packageDirectory} does not support ${target.arch}`);
    const dependencies = dependencySets(packageJson);
    for (const name of dependencies.required) {
      const resolved = resolveArchiveDependency(packageDirectory, name, directories);
      if (!resolved) fail(`Archive is missing required dependency ${name} for ${packageJson.name}`);
      const dependencyJson = files.get(`${resolved}/package.json`);
      if (!dependencyJson) fail(`Archive dependency ${name} has no package.json`);
      if (JSON.parse(dependencyJson.toString('utf8')).name !== name) fail(`Archive dependency ${name} has the wrong package identity`);
    }
    for (const name of dependencies.optional) {
      const resolved = resolveArchiveDependency(packageDirectory, name, directories);
      if (resolved && !files.has(`${resolved}/package.json`)) fail(`Optional archive dependency ${name} has no package.json`);
    }
  }
}

export function verifyRelocatableArchive(archivePath, { expectedVersion, sourceCommit, target, extractDirectory } = {}) {
  target = validateArtifactTarget(target);
  const compressed = readFileSync(archivePath);
  if (compressed.length > ARCHIVE_LIMITS.compressedBytes) fail('Archive exceeds 256 MiB compressed');
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: ARCHIVE_LIMITS.expandedBytes });
  } catch (error) {
    fail(`Archive gzip stream is invalid or oversized: ${error.message}`);
  }
  if (tar.length > ARCHIVE_LIMITS.expandedBytes) fail('Archive exceeds 512 MiB expanded');

  const seen = new Set();
  const directories = new Set();
  const files = new Map();
  let offset = 0;
  let nextPath = null;
  let entries = 0;
  let ended = false;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      const second = tar.subarray(offset, offset + BLOCK_SIZE);
      if (second.length !== BLOCK_SIZE || !second.every((byte) => byte === 0)) fail('Archive is missing its second end block');
      offset += BLOCK_SIZE;
      if (!tar.subarray(offset).every((byte) => byte === 0)) fail('Archive contains nonzero trailing data');
      ended = true;
      break;
    }
    verifyTarHeader(header);
    entries += 1;
    if (entries > ARCHIVE_LIMITS.entries) fail('Archive contains more than 50,000 entries');
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = parseTarNumber(header, 124, 12);
    const mode = parseTarNumber(header, 100, 8);
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'x' || type === 'L') {
      if (size > ARCHIVE_LIMITS.metadataBytes) fail('Archive path metadata exceeds 64 KiB');
    } else if (type === '0') {
      if (size > ARCHIVE_LIMITS.fileBytes) fail(`Archive file exceeds 128 MiB: ${headerPath}`);
    } else if (type === '5') {
      if (size !== 0) fail(`Archive directory contains data: ${headerPath}`);
    } else {
      fail(`Archive entry type ${type} is not allowed`);
    }
    const dataEnd = offset + size;
    if (dataEnd > tar.length) fail('Archive entry exceeds the tar stream');
    const data = tar.subarray(offset, dataEnd);
    offset = dataEnd + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);

    if (type === 'x' || type === 'L') {
      nextPath = type === 'x' ? parsePaxPath(data) : data.toString('utf8').replace(/\0.*$/s, '').trimEnd();
      continue;
    }
    const entryPath = nextPath || headerPath;
    nextPath = null;
    const relativePath = safePath(entryPath);
    const canonical = relativePath ? `package/${relativePath}` : 'package';
    if (seen.has(canonical)) fail(`Archive contains a duplicate entry: ${canonical}`);
    seen.add(canonical);
    if (type === '5') {
      directories.add(canonical);
      if (extractDirectory && relativePath) mkdirSync(join(extractDirectory, ...relativePath.split('/')), { recursive: true, mode: 0o755 });
    } else {
      files.set(canonical, Buffer.from(data));
      if (extractDirectory) {
        const destination = join(extractDirectory, ...relativePath.split('/'));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
        writeFileSync(destination, data, { mode: (mode & 0o111) !== 0 ? 0o755 : 0o644, flag: 'wx' });
      }
    }
  }
  if (!ended) fail('Archive does not contain two end blocks');
  if (nextPath) fail('Archive ends with unused path metadata');
  for (const required of REQUIRED_PATHS) {
    const collection = required.endsWith('/') ? directories : files;
    const key = required.endsWith('/') ? required.slice(0, -1) : required;
    if (!collection.has(key)) fail(`Archive is missing ${required}`);
  }
  if (!directories.has('package')) fail('Archive has no package/ root directory');

  const packageJson = JSON.parse(files.get('package/package.json').toString('utf8'));
  if (packageJson.name !== '@openchamber/web') fail('Archive package name is invalid');
  if (expectedVersion && packageJson.version !== expectedVersion) fail(`Archive version ${packageJson.version} does not match ${expectedVersion}`);
  if (packageJson.bin?.openchamber !== './bin/cli.js') fail('Archive does not expose the OpenChamber CLI');
  if (JSON.stringify(Object.keys(packageJson.openchamberArtifact || {}).sort()) !== JSON.stringify(['arch', 'nodeAbi', 'platform'])) {
    fail('Archive package target metadata has invalid keys');
  }
  if (JSON.stringify(packageJson.openchamberArtifact) !== JSON.stringify(target)) fail('Archive package target metadata does not match');
  const revision = JSON.parse(files.get('package/dist/build-revision.json').toString('utf8'));
  if (Object.keys(revision).length !== 1 || !/^[0-9a-f]{40}$/.test(revision.revision)) fail('Archive build revision is invalid');
  if (sourceCommit && revision.revision !== sourceCommit) fail('Archive build revision does not match source commit');
  validateDependencyClosure(files, directories, target);
  return { compressedBytes: compressed.length, expandedBytes: tar.length, entries, files: files.size, revision: revision.revision };
}
