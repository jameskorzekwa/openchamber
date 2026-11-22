import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { EXT_UNCARRIABLE, transferErrorProperty, transferValue as present } from './code-transfer.js';
import type { AllowedNameOptions, NameNode, NameOptions, RedirectedFolderOptions, ReportedPaths } from './code-out-contracts.js';

const MAX_REPORTED_PATHS = 100;

const nameFolder = ({ ignoreCase, precompose }: NameOptions) => (name: string) => {
  if (!ignoreCase) return precompose ? name.normalize('NFC') : name;
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
};

export async function firstRedirectedFolder(top: string, paths: string[], { ignoreCase = false, precompose = false, deletedLinks = [], lstat = fs.lstat, realpath = fs.realpath }: RedirectedFolderOptions = {}) {
  const root = await realpath(top);
  const fold = nameFolder({ ignoreCase, precompose });
  const kinds = new Map<string, string>();
  const reals = new Map<string, boolean>();
  const goingLinks = new Set(deletedLinks);
  const leadsElsewhere = async (relative: string) => {
    if (!reals.has(relative)) {
      const real = path.relative(root, await realpath(path.join(top, ...relative.split('/')))).split(path.sep).join('/');
      reals.set(relative, fold(real) !== fold(relative));
    }
    return reals.get(relative);
  };
  for (const file of paths) {
    const folders = file.split('/').slice(0, -1);
    let relative = '';
    let deepest = '';
    for (const folder of folders) {
      relative = relative === '' ? folder : `${relative}/${folder}`;
      if (!kinds.has(relative)) {
        let kind = 'folder';
        try {
          const stats = await lstat(path.join(top, ...relative.split('/')));
          if (stats.isSymbolicLink()) kind = goingLinks.has(relative) ? 'absent' : 'link';
          else if (!stats.isDirectory()) kind = 'other';
        } catch (error) {
          if (transferErrorProperty(error, 'code') !== 'ENOENT' && transferErrorProperty(error, 'code') !== 'ENOTDIR') throw error;
          kind = 'absent';
        }
        kinds.set(relative, kind);
      }
      const kind = kinds.get(relative);
      if (kind === 'link') return relative;
      if (kind !== 'folder') break;
      deepest = relative;
    }
    if (deepest !== '' && await leadsElsewhere(deepest)) {
      let above = '';
      for (const folder of deepest.split('/')) {
        above = above === '' ? folder : `${above}/${folder}`;
        if (await leadsElsewhere(above)) return above;
      }
    }
  }
  return null;
}

const WINDOWS_RESERVED_CHARACTER = /[<>:"/\\|?*]|(?!\0|[\x7f-\x9f])\p{Cc}/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[0-9¹²³]) *(?:[.:]|$)/i;
const WINDOWS_TRAILING = /[ .]$/;
const WINDOWS_MAX_PATH = 259;
const WINDOWS_MAX_FOLDER_PATH = 247;
const MAX_NAME_BYTES = 255;
const MAX_PATH_BYTES = 1023;

const nameRule = (name: string, platform: NodeJS.Platform) => {
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return 'name_too_long';
  if (platform !== 'win32') return null;
  if (WINDOWS_RESERVED_CHARACTER.test(name)) return 'reserved_character';
  if (WINDOWS_DEVICE_NAME.test(name)) return 'device_name';
  if (WINDOWS_TRAILING.test(name)) return 'trailing_space_or_period';
  return null;
};

export function nameNotAllowedHere(created: string[], all: string[], { platform = process.platform, ignoreCase = false, precompose = false, deleted = [], top = '', longPaths = false }: AllowedNameOptions = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const file of created) {
    const whole = top === '' ? file : join(top, file);
    if (Buffer.byteLength(whole) > MAX_PATH_BYTES) return { path: file, rule: 'path_too_long', other: null };
    if (platform === 'win32' && !longPaths && top !== '') {
      if (whole.length > WINDOWS_MAX_PATH) return { path: file, rule: 'path_too_long', other: null };
      const folder = file.includes('/') ? join(top, file.slice(0, file.lastIndexOf('/'))) : '';
      if (folder.length > WINDOWS_MAX_FOLDER_PATH) return { path: file, rule: 'path_too_long', other: null };
    }
    for (const name of file.split('/')) {
      const rule = nameRule(name, platform);
      if (rule) return { path: file, rule, other: null };
    }
  }
  if ((!ignoreCase && !precompose) || created.length === 0) return null;
  const fold = nameFolder({ ignoreCase, precompose });
  const node = (): NameNode => ({ children: new Map(), spellings: new Map() });
  const root = node();
  for (const file of created) {
    let at = root;
    for (const name of file.split('/')) {
      const key = fold(name);
      if (!at.children.has(key)) at.children.set(key, node());
      at = present(at.children.get(key));
    }
  }
  const mark = (file: string, present: boolean, old: boolean) => {
    let at: NameNode | undefined = root;
    let from = 0;
    for (;;) {
      const end = file.indexOf('/', from);
      const name = end === -1 ? file.slice(from) : file.slice(from, end);
      at = at.children.get(fold(name));
      if (!at) return;
      const seen = at.spellings.get(name) ?? { present: false, old: false };
      at.spellings.set(name, { present: seen.present || present, old: seen.old || old });
      if (end === -1) return;
      from = end + 1;
    }
  };
  const isCreated = new Set(created);
  for (const file of all) mark(file, true, !isCreated.has(file));
  for (const file of created) mark(file, true, false);
  for (const file of deleted) mark(file, false, true);
  for (const file of created) {
    const names = file.split('/');
    let at = root;
    for (let depth = 0; depth < names.length; depth += 1) {
      at = present(at.children.get(fold(present(names[depth]))));
      if (present(at.spellings.get(present(names[depth]))).old) continue;
      const others = [...at.spellings].filter(([name]) => name !== names[depth]);
      const staying = others.find(([, seen]) => seen.present);
      const going = others.find(([, seen]) => !seen.present);
      const other = staying ?? going;
      if (other) {
        return { path: file, rule: staying ? 'differs_only_in_case' : 'case_only_rename', other: [...names.slice(0, depth), other[0]].join('/') };
      }
    }
  }
  return null;
}

export async function conflictedPaths(patch: string) {
  const paths = [];
  let file = '';
  const lines = readline.createInterface({ input: createReadStream(patch), crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      if (text.startsWith('+++ b/')) file = text.slice('+++ b/'.length);
      else if (file !== '' && text.startsWith('+<<<<<<< ')) {
        paths.push(file);
        file = '';
      }
    }
  } finally {
    lines.close();
  }
  return reported(paths);
}

export const reported = (paths: string[]): ReportedPaths => {
  const all = [...new Set(paths.filter((entry) => entry !== ''))];
  return { count: all.length, paths: all.slice(0, MAX_REPORTED_PATHS).map((entry) => entry.replace(new RegExp(EXT_UNCARRIABLE, 'gu'), '?')) };
};
