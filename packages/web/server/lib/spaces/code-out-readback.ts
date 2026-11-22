import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { line, transferErrorProperty, transferValue as present } from './code-transfer.js';
import type { HostGit } from './code-transfer.js';
import type { CommandOptions } from './command-contracts.js';
import type { ApplyCall, CodeOutOptions, ComparedPath, FileReading, GitSide, ReadFailureState } from './code-out-contracts.js';
import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { reported } from './code-out-paths.js';

export const APPLY_TIMEOUT_MS = 10 * 60_000;
export const LIST_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const APPLY_OUTPUT_TAIL_BYTES = 64 * 1024;
const PATCH_ARGS = ['diff-tree', '-r', '-p', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
export const APPLY_ARGS = ['-c', 'apply.whitespace=nowarn', '-c', 'apply.ignoreWhitespace=no', 'apply', '--binary', '--whitespace=nowarn'];

const pause = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

const READ_AT_ONCE = 8;
const READ_PIECE_BYTES = 64 * 1024;

const blobId = (algorithm: string, bytes: Buffer) => crypto.createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

const CHANGED_WHILE_READ = Symbol('changed while read');
const READS_OF_A_CHANGING_FILE = 4;
const PAUSE_BETWEEN_READS_MS = 100;

async function hashFile(files: Pick<typeof fs, 'open'>, full: string, algorithm: string, until: number) {
  let handle;
  try {
    handle = await files.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const hash = crypto.createHash(algorithm).update(`blob ${stats.size}\0`);
    const piece = Buffer.allocUnsafe(Math.max(1, Math.min(READ_PIECE_BYTES, stats.size)));
    let total = 0;
    for (;;) {
      if (Date.now() > until) throw new SpaceError('command_timeout', 'Reading a file of the working tree back did not end in time');
      const { bytesRead } = await handle.read(piece, 0, piece.length, null).catch(() => ({ bytesRead: -1 }));
      if (bytesRead < 0) return null;
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > stats.size) return CHANGED_WHILE_READ;
      hash.update(piece.subarray(0, bytesRead));
    }
    return total === stats.size ? hash.digest('hex') : CHANGED_WHILE_READ;
  } finally {
    await handle.close();
  }
}

export const listChange = async (g: HostGit, where: string, from: string, to: string) => (await g.output(where, ['diff-tree', '-r', '-z', '--no-renames', from, to], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\0');

const writePatch = (g: HostGit, top: string, from: string, to: string, file: string) => g.output(top, [...PATCH_ARGS, `--output=${file}`, from, to], { timeoutMs: APPLY_TIMEOUT_MS });

const dryRun = (g: HostGit, top: string, patch: string, { reverse = false } = {}) => g.run(top, [...APPLY_ARGS, '--check', ...(reverse ? ['--reverse'] : []), patch], {
  timeoutMs: APPLY_TIMEOUT_MS, maxOutputBytes: APPLY_OUTPUT_TAIL_BYTES, keepTail: true, killTree: true,
});


export function createCodeOutReadback({ files, readBackTimeoutMs }: {
  files: NonNullable<CodeOutOptions['files']>;
  readBackTimeoutMs: number;
}) {
  const startCall = (g: HostGit, directory: string, top: string): ApplyCall => ({
    g, directory, top, until: Date.now() + readBackTimeoutMs, listings: new Map(), patches: new Map(), files: 0,
    settings: null, readings: new Map(), folders: new Map(), commits: new Map(),
  });

  const undecided = (failed: string | null = null) => new SpaceError(
    'changes_undecided',
    failed === null
      ? `Reading your project back took longer than ${Math.round(readBackTimeoutMs / 1000)} seconds, so it is not known how much of what was last applied from this space is still there.`
      : `Reading your project back failed, so it is not known how much of what was last applied from this space is still there. ${failed}`,
    failed === null ? { limitMs: readBackTimeoutMs } : { limitMs: readBackTimeoutMs, cause: 'read_back_failed' },
  );

  const readingBack = (call: ApplyCall): HostGit => {
    const bounded = <Result>(method: (where: string, args: string[], options?: CommandOptions) => Promise<Result>) => async (where: string, args: string[], options: CommandOptions = {}) => {
      const left = call.until - Date.now();
      if (left <= 0) throw undecided();
      try {
        return await method(where, args, { ...options, killTree: true, timeoutMs: Math.min(options.timeoutMs ?? APPLY_TIMEOUT_MS, left) });
      } catch (error) {
        if (transferErrorProperty(error, 'code') === 'command_timeout' || transferErrorProperty(error, 'code') === 'command_output_too_large') throw undecided();
        throw error;
      }
    };
    return { run: bounded(call.g.run), output: bounded(call.g.output) };
  };

  const listed = async (call: ApplyCall, g: HostGit, from: string, to: string) => {
    const key = `${from} ${to}`;
    if (!call.listings.has(key)) call.listings.set(key, await listChange(g, call.top, from, to));
    return present(call.listings.get(key));
  };

  const patchOf = async (call: ApplyCall, g: HostGit, from: string, to: string) => {
    const key = `${from} ${to}`;
    if (!call.patches.has(key)) {
      call.files += 1;
      const file = path.join(call.directory, `change-${call.files}.patch`).replaceAll('\\', '/');
      await writePatch(g, call.top, from, to, file);
      call.patches.set(key, { file, check: null });
    }
    return present(call.patches.get(key));
  };

  const checkOf = async (call: ApplyCall, g: HostGit, from: string, to: string) => {
    const patch = await patchOf(call, g, from, to);
    patch.check ??= await dryRun(g, call.top, patch.file);
    return patch.check;
  };

  const ABSENT = '000000';
  const GITLINK = '160000';
  const LINK = '120000';
  const EXECUTABLE = '100755';
  const isRegular = (side: GitSide) => side.mode === '100644' || side.mode === EXECUTABLE;

  const readFlag = async (g: HostGit, top: string, key: string, fallback: boolean) => {
    const found = await g.run(top, ['config', '--bool', '--get', key]);
    return found.code === 0 ? line(found.stdout) === 'true' : fallback;
  };

  const settingsOf = async (call: ApplyCall) => {
    call.settings ??= {
      algorithm: line(await call.g.output(call.top, ['rev-parse', '--show-object-format'])),
      filemode: await readFlag(call.g, call.top, 'core.filemode', true),
      symlinks: await readFlag(call.g, call.top, 'core.symlinks', true),
    };
    return call.settings;
  };

  const comparedPaths = async (call: ApplyCall, g: HostGit, from: string, to: string) => {
    const { filemode } = await settingsOf(call);
    const fields = await listed(call, g, from, to);
    const entries = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId] = present(fields[index]).slice(1).split(' ');
      if (oldMode === GITLINK || newMode === GITLINK) continue;
      if (!filemode && oldId === newId && oldMode !== LINK && newMode !== LINK) continue;
      entries.push({ path: present(fields[index + 1]), from: { mode: oldMode, id: oldId }, to: { mode: newMode, id: newId } });
    }
    return entries;
  };

  const plainWay = async (call: ApplyCall, file: string) => {
    let relative = '';
    for (const name of file.split('/').slice(0, -1)) {
      relative = relative === '' ? name : `${relative}/${name}`;
      if (!call.folders.has(relative)) {
        call.folders.set(relative, await files.lstat(path.join(call.top, ...relative.split('/'))).then((stats) => stats.isDirectory(), () => false));
      }
      if (!call.folders.get(relative)) return false;
    }
    return true;
  };

  const lookAt = async (call: ApplyCall, file: string) => {
    if (call.readings.has(file)) return call.readings.get(file);
    const { algorithm } = await settingsOf(call);
    const full = path.join(call.top, ...file.split('/'));
    let reading: FileReading = { kind: 'absent' };
    if (await plainWay(call, file)) {
      const stats = await files.lstat(full).catch(() => null);
      if (stats?.isSymbolicLink()) {
        const target = await files.readlink(full, { encoding: 'buffer' }).catch(() => null);
        reading = target === null ? { kind: 'other' } : { kind: 'link', raw: blobId(algorithm, target) };
      } else if (stats?.isFile()) {
        let raw: string | typeof CHANGED_WHILE_READ | null = CHANGED_WHILE_READ;
        try {
          for (let read = 0; raw === CHANGED_WHILE_READ && read < READS_OF_A_CHANGING_FILE; read += 1) {
            if (read > 0) await pause(PAUSE_BETWEEN_READS_MS);
            raw = await hashFile(files, full, algorithm, call.until);
          }
        } catch (error) {
          if (transferErrorProperty(error, 'code') === 'command_timeout') throw undecided();
          throw error;
        }
        if (raw === null) throw undecided(`${reported([file]).paths[0]} could not be read as a plain file.`);
        if (raw === CHANGED_WHILE_READ) throw undecided(`${reported([file]).paths[0]} kept changing while it was read.`);
        reading = { kind: 'file', executable: (stats.mode & 0o100) !== 0, raw, clean: undefined };
      } else if (stats) {
        reading = { kind: 'other' };
      }
    }
    call.readings.set(file, reading);
    return reading;
  };

  const cleanIds = async (call: ApplyCall, g: HostGit, paths: string[]) => {
    const env = { GIT_INDEX_FILE: path.join(call.directory, 'no-index') };
    const { algorithm } = await settingsOf(call);
    const idLength = algorithm === 'sha256' ? 64 : 40;
    const asked = paths.filter((file) => call.readings.get(file)?.kind === 'file' && present(call.readings.get(file)).clean === undefined);
    const odd = (file: string) => /[\n\r]/.test(file) || file.startsWith('"');
    const together = asked.filter((file) => !odd(file));
    const answer = async (args: string[], stdin: string, count: number) => {
      const done = await g.run(call.top, args, { env, stdin, maxOutputBytes: count * (idLength + 1) + APPLY_OUTPUT_TAIL_BYTES, keepTail: true });
      const ids = done.stdout.split('\n').filter(Boolean);
      if (done.code !== 0 || ids.length !== count) throw undecided(`Git said: ${tail(done.stderr) || `exit code ${done.code}`}`);
      return ids;
    };
    if (together.length > 0) {
      const ids = await answer(['hash-object', '--stdin-paths'], together.map((file) => `${file}\n`).join(''), together.length);
      together.forEach((file, index) => { present(call.readings.get(file)).clean = ids[index]; });
    }
    for (const file of asked.filter(odd)) {
      [present(call.readings.get(file)).clean] = await answer(['hash-object', '--', file], '', 1);
    }
  };

  const fits = (call: ApplyCall, reading: FileReading, side: GitSide) => {
    if (side.mode === ABSENT) return reading.kind === 'absent';
    if (side.mode === LINK) return reading.kind === 'link' || (!present(call.settings ?? undefined).symlinks && reading.kind === 'file');
    return reading.kind === 'file' && (!present(call.settings ?? undefined).filemode || reading.executable === (side.mode === EXECUTABLE));
  };
  const holdsRaw = (call: ApplyCall, reading: FileReading, side: GitSide) => fits(call, reading, side) && (side.mode === ABSENT || reading.raw === side.id);
  const holdsClean = (call: ApplyCall, reading: FileReading, side: GitSide) => isRegular(side) && fits(call, reading, side) && reading.clean === side.id;

  const lookAtAll = async (call: ApplyCall, entries: ComparedPath[]) => {
    const failed: ReadFailureState = { current: null };
    let next = 0;
    const worker = async () => {
      while (failed.current === null && next < entries.length) {
        const entry = entries[next];
        next += 1;
        try {
          await lookAt(call, present(entry).path);
        } catch (error) {
          failed.current ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, entries.length) }, worker));
    if (failed.current !== null) throw failed.current;
  };

  const sidesHeld = async (call: ApplyCall, g: HostGit, entries: ComparedPath[]) => {
    await lookAtAll(call, entries);
    const reading = (entry: ComparedPath) => present(call.readings.get(entry.path));
    await cleanIds(call, g, entries
      .filter((entry) => (isRegular(entry.to) || isRegular(entry.from)) && !holdsRaw(call, reading(entry), entry.to) && !holdsRaw(call, reading(entry), entry.from))
      .map((entry) => entry.path));
    return entries.map((entry) => {
      if (holdsRaw(call, reading(entry), entry.to)) return 'to';
      if (holdsRaw(call, reading(entry), entry.from)) return 'from';
      if (holdsClean(call, reading(entry), entry.to)) return 'to';
      if (holdsClean(call, reading(entry), entry.from)) return 'from';
      return 'neither';
    });
  };

  const committedAmong = async (call: ApplyCall, g: HostGit, since: string | null, head: string | null, paths: string[]) => {
    if (since === head || head === null || paths.length === 0) return new Set<string>();
    const range = since === null ? [head] : [head, `^${since}`];
    const key = range.join(' ');
    if (!call.commits.has(key)) {
      const names = await g.output(call.top, ['--literal-pathspecs', 'log', '--format=', '--name-only', '-z', '--no-renames', '--no-show-signature', ...range, '--'], {
        maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      });
      const changed = new Set<string>();
      for (const name of names.split('\0')) {
        if (name !== '') changed.add(name).add(name.replace(/^\n+/, ''));
      }
      call.commits.set(key, changed);
    }
    const changed = present(call.commits.get(key));
    return new Set(paths.filter((file) => changed.has(file)));
  };

  const LOOK_GROWTH = 16;
  const inLooks = (list: ComparedPath[]) => {
    const looks = [];
    for (let at = 0, size = 1; at < list.length; at += size, size *= LOOK_GROWTH) looks.push(list.slice(at, at + size));
    return looks;
  };

  const whatBecameOf = async (call: ApplyCall, g: HostGit, before: string, applied: string, { appliedHead, head, untilTrace = false }: { appliedHead: string | null; head: string | null; untilTrace?: boolean }) => {
    const entries = await comparedPaths(call, g, before, applied);
    const kept: string[] = [];
    const edited: string[] = [];
    const thrown: string[] = [];
    for (const look of untilTrace ? inLooks(entries) : [entries]) {
      const held = await sidesHeld(call, g, look);
      const committed = await committedAmong(call, g, appliedHead, head, look.filter((_, index) => held[index] === 'from').map((entry) => entry.path));
      look.forEach((entry, index) => {
        if (held[index] === 'to') kept.push(entry.path);
        else if (held[index] === 'neither' || committed.has(entry.path)) edited.push(entry.path);
        else thrown.push(entry.path);
      });
      if (untilTrace && kept.length + edited.length > 0) break;
    }
    return { kept, edited, thrown, trace: kept.length + edited.length > 0 || thrown.length === 0 };
  };

  const interruptedApplyState = async (call: ApplyCall, g: HostGit, from: string, to: string) => {
    const held = await sidesHeld(call, g, await comparedPaths(call, g, from, to));
    if (held.every((side) => side === 'to')) return 'finished';
    if (held.every((side) => side === 'from')) return 'not_started';
    if (!held.includes('to') && (await checkOf(call, g, from, to)).code === 0) return 'not_started';
    if (!held.includes('from') && (await dryRun(g, call.top, (await patchOf(call, g, from, to)).file, { reverse: true })).code === 0) return 'finished';
    return 'partly';
  };

  const readInterrupted = async (call: ApplyCall, g: HostGit, applying: string, base: string, others: (string | null)[]) => {
    const state = await interruptedApplyState(call, g, base, applying);
    if (state !== 'partly') return { state, base };
    for (const other of new Set(others.filter((candidate) => candidate !== null && candidate !== base))) {
      const again = await interruptedApplyState(call, g, present(other ?? undefined), applying);
      if (again !== 'partly') return { state: again, base: other };
    }
    return { state, base };
  };

  const decideBase = async (call: ApplyCall, g: HostGit, { start, applied, appliedFrom, appliedHead, head }: { start: string; applied: string | null; appliedFrom: string | null; appliedHead: string | null; head: string | null }) => {
    if (applied === null) return { from: start };
    if (appliedFrom === null) return { from: applied };
    if (appliedFrom !== start && !(await whatBecameOf(call, g, start, applied, { appliedHead, head, untilTrace: true })).trace) return { from: start };
    const last = await whatBecameOf(call, g, appliedFrom, applied, { appliedHead, head });
    const stillThere = [...last.kept, ...last.edited];
    if (last.thrown.length > 0 && stillThere.length > 0) return { partly: { gone: last.thrown, stillThere } };
    if (last.thrown.length > 0) return { from: appliedFrom };
    return { from: applied };
  };

  const filteredInTheWay = async (call: ApplyCall, g: HostGit, from: string, result: string) => {
    const entries = (await comparedPaths(call, g, from, result)).filter((entry) => isRegular(entry.from));
    await lookAtAll(call, entries);
    const bytesAsBefore = entries.filter((entry) => holdsRaw(call, present(call.readings.get(entry.path)), entry.from));
    if (bytesAsBefore.length === 0) return [];
    const env = { GIT_INDEX_FILE: path.join(call.directory, 'no-index') };
    const drivers = new Set((await g.run(call.top, ['config', '-z', '--get-regexp', '^filter\\..*\\.(clean|process)$'])).stdout.split('\0').filter(Boolean)
      .map((entry) => entry.slice(0, entry.indexOf('\n')).replace(/^filter\./, '').replace(/\.(?:clean|process)$/, '')));
    const fields = (await g.output(call.top, ['check-attr', '-z', '--stdin', 'filter'], { env, stdin: bytesAsBefore.map((entry) => `${entry.path}\0`).join('') })).split('\0');
    const covered = new Set();
    for (let index = 0; index + 2 < fields.length; index += 3) {
      if (drivers.has(present(fields[index + 2]))) covered.add(fields[index]);
    }
    const asked = bytesAsBefore.filter((entry) => covered.has(entry.path));
    await cleanIds(call, g, asked.map((entry) => entry.path));
    return asked.filter((entry) => present(call.readings.get(entry.path)).clean !== entry.from.id).map((entry) => entry.path);
  };

  const differFromHead = async (call: ApplyCall, g: HostGit, head: string | null, paths: string[]) => {
    const sides = new Map<string, GitSide>();
    if (head !== null) {
      const tree = await g.output(call.top, ['ls-tree', '-r', '-z', '--full-tree', head], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES });
      for (const entry of tree.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const [mode, , id] = entry.slice(0, tab).split(' ');
        sides.set(entry.slice(tab + 1), { mode, id });
      }
    }
    const entries = paths.map((file) => ({ path: file, head: sides.get(file) ?? { mode: ABSENT, id: '' } }));
    const reading = (entry: { path: string }) => present(call.readings.get(entry.path));
    await cleanIds(call, g, entries.filter((entry) => isRegular(entry.head) && !holdsRaw(call, reading(entry), entry.head)).map((entry) => entry.path));
    return entries.some((entry) => !holdsRaw(call, reading(entry), entry.head) && !holdsClean(call, reading(entry), entry.head));
  };

  return {
    startCall,
    readingBack,
    listed,
    patchOf,
    checkOf,
    readInterrupted,
    decideBase,
    filteredInTheWay,
    differFromHead,
  };
}
