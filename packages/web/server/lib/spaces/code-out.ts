import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EXT_UNCARRIABLE,
  INNER_MARGIN_SECONDS,
  SNAPSHOT_IDENTITY,
  buildExtUrl,
  createTransferSession,
  innerSeconds,
  line,
  objectIdPattern,
  requireInnerMargin,
  requireTimeout,
  spaceRefPrefix,
  startRef,
  zeroObjectId,
  transferErrorProperty,
  transferValue as present,
  withTransferErrorDetails,
} from './code-transfer.js';
import type { HostGit } from './code-transfer.js';
import type {
  ApplyCall,
  ApplyChangesResult,
  ApplyRequest,
  ApplyState,
  ChangeLimits,
  ChangeRefusals,
  CodeOutOptions,
  CodeOutRequest,
  CodeOutSummary,
  ReportedPaths,
  TransferStepDetails,
} from './code-out-contracts.js';
import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { requireSpaceId } from './labels.js';
import { IMAGE_GIT, IMAGE_ONLY_PATH, IMAGE_SH, IMAGE_TIMEOUT, requireSpaceProjectPath } from './layout.js';
import { firstRedirectedFolder, nameNotAllowedHere, conflictedPaths, reported } from './code-out-paths.js';
import {
  APPLY_TIMEOUT_MS,
  LIST_MAX_OUTPUT_BYTES,
  APPLY_OUTPUT_TAIL_BYTES,
  APPLY_ARGS,
  listChange,
  createCodeOutReadback,
} from './code-out-readback.js';
export { firstRedirectedFolder, nameNotAllowedHere } from './code-out-paths.js';

const FETCH_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const MAX_CHANGED_BYTES = 128 * 1024 * 1024;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_ENTRIES = 100_000;
const FOLDER_STEPS_PER_ENTRY = 32;
const FETCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const READ_BACK_TIMEOUT_MS = 5 * 60_000;
const SIZE_POLL_MS = 100;

const INSIDE_RESULT = 'refs/openchamber/result';
const QUARANTINE_RESULT = 'refs/openchamber/result';
const resultRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}result`;
const appliedRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applied`;
const closedRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}changes-closed`;
const applyingRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applying`;
const appliedFromRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applied-from`;
const applyingFromRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applying-from`;
const appliedHeadRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applied-head`;
const applyingHeadRef = (spaceId: string) => `${spaceRefPrefix(spaceId)}applying-head`;
const BRANCH_FROM_NOW_ON = 'From now on this space is applied as a branch, which holds its whole work, the rounds you already applied included.';

const UNCOMMITTED_MESSAGE = 'openchamber: uncommitted changes from the space\n\nWhat was uncommitted in the space when its work was brought out. Some of it may be the work you had uncommitted when the space was made.';

const MAX_REPORT_BYTES = 256 * 1024;

const SNAPSHOT_SCRIPT = [
  IMAGE_ONLY_PATH,
  'exec 3>&1 >/dev/null;',
  '{',
  'cd "$1" || exit 1;',
  'report=$(git rev-parse --git-path openchamber-unmerged) || exit 1;',
  `git ls-files --unmerged -z | head -c ${MAX_REPORT_BYTES} > "$report";`,
  'head=$(git rev-parse --verify --quiet "HEAD^{commit}") || { echo "The repository in the space has no commit at HEAD." >&2; exit 1; };',
  'index=$(git rev-parse --git-path index) && copy=$(git rev-parse --git-path openchamber-result-index) || exit 1;',
  'rm -f "$copy";',
  'if [ -e "$index" ]; then cp "$index" "$copy" || exit 1; fi;',
  'GIT_INDEX_FILE="$copy" git -c core.splitIndex=false add --all && tree=$(GIT_INDEX_FILE="$copy" git -c core.splitIndex=false write-tree);',
  'status=$?; rm -f "$copy"; [ "$status" -eq 0 ] || exit 1;',
  'if [ "$tree" = "$(git rev-parse "$head^{tree}")" ]; then result=$head;',
  'else result=$(GIT_AUTHOR_NAME="$3" GIT_AUTHOR_EMAIL="$4" GIT_COMMITTER_NAME="$3" GIT_COMMITTER_EMAIL="$4" git commit-tree --no-gpg-sign "$tree" -p "$head" -m "$2") || exit 1; fi;',
  `git update-ref ${INSIDE_RESULT} "$result" || exit 1;`,
  '} 3>&-;',
  'printf "%s\n" "$result" >&3;',
  'cat "$report" >&3;',
  'rm -f "$report"',
].join(' ');

const FETCH_CONFIG = [
  '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
  '-c', 'fetch.prune=false', '-c', 'fetch.writeCommitGraph=false',
];
const QUARANTINE_CONFIG = ['-c', 'fetch.unpackLimit=1', '-c', 'transfer.unpackLimit=1'];
const FETCH_FLAGS = ['--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-gc', '--refmap='];


const LIMIT_NAMES = ['maxTransferBytes', 'maxChangedBytes', 'maxChangedEntries'] as const;
const requireLimit = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SpaceError('invalid_limit', `${name} is a whole number greater than zero`);
  }
  return value;
};

const OUT_CODES = new Set([
  'invalid_space_id', 'invalid_space_path', 'invalid_timeout', 'invalid_inner_margin', 'invalid_limit',
  'git_version_unreadable', 'git_too_old', 'project_folder_missing', 'not_a_git_work_tree', 'space_start_missing',
  'code_out_failed', 'result_ref_missing', 'result_not_a_commit', 'result_transfer_too_large', 'result_too_large', 'result_too_many_changes',
]);

const applyTurns = new Map<string, Promise<void>>();

const inTurn = async <Result>(key: string, work: () => Promise<Result>) => {
  const earlier = applyTurns.get(key);
  let done = () => {};
  const mine = new Promise<void>((resolve) => { done = resolve; });
  applyTurns.set(key, mine);
  try {
    await earlier;
    return await work();
  } finally {
    done();
    if (applyTurns.get(key) === mine) applyTurns.delete(key);
  }
};

async function folderBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await folderBytes(full);
    } else {
      total += await fs.lstat(full).then((stats) => stats.size, () => 0);
    }
  }
  return total;
}

const readReport = (text: string) => {
  const report = String(text ?? '');
  const end = report.indexOf('\n');
  return {
    result: end === -1 ? '' : report.slice(0, end),
    unmerged: reported(report.slice(end + 1).split('\0').filter((entry) => entry.includes('\t')).map((entry) => entry.slice(entry.indexOf('\t') + 1))),
  };
};

const parseSizes = (text: string) => text.split('\n').filter(Boolean).map((entry) => {
  const [id, type, size] = entry.split(' ');
  if (type === 'missing' || !/^\d+$/.test(size ?? '')) {
    throw new SpaceError('code_out_failed', `An object of the result is missing from the quarantine: ${id}`, { cause: 'object_missing' });
  }
  return { id, type, size: Number(size) };
});

export function createCodeOut({ git, place, temporaryDirectory = os.tmpdir(), removeDirectory, platform = process.platform, readBackTimeoutMs = READ_BACK_TIMEOUT_MS, sizePollMs = SIZE_POLL_MS, files = fs }: CodeOutOptions) {
  const { withHostGit, requireGitVersion, requireWorkTree } = createTransferSession({ git, temporaryDirectory, removeDirectory, name: 'code out' });
  const during = async <Result>(step: string, work: () => Promise<Result>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SpaceError && OUT_CODES.has(error.code)) throw error;
      const ours = error instanceof SpaceError;
      const details: TransferStepDetails = { step };
      if (ours) Object.assign(details, error.details);
      details.cause = transferErrorProperty(error, 'code') ?? null;
      throw new SpaceError('code_out_failed', ours ? error.message : `Code out failed on the host: ${transferErrorProperty(error, 'message')}`, details);
    }
  };

  const readRef = async (g: HostGit, where: string, ref: string) => {
    const found = await g.run(where, ['rev-parse', '--verify', '--quiet', `${ref}^{object}`]);
    return found.code === 0 ? line(found.stdout) : null;
  };

  const requireStart = async (g: HostGit, top: string, spaceId: string) => {
    const start = await readRef(g, top, startRef(spaceId));
    if (!start) {
      throw new SpaceError('space_start_missing', `This repository holds no start snapshot for space ${spaceId}. The work of a space can come out only into the repository its code came from.`);
    }
    return start;
  };

  const requireResult = async (g: HostGit, top: string, spaceId: string) => {
    const result = await readRef(g, top, resultRef(spaceId));
    if (!result) {
      throw new SpaceError('result_missing', `There is no result of space ${spaceId} in this repository yet. Bring the space's work out first.`);
    }
    return result;
  };

  const fetchIntoQuarantine = async (g: HostGit, quarantine: string, url: string, timeoutMs: number, maxTransferBytes: number) => {
    const tooLarge = () => new SpaceError(
      'result_transfer_too_large',
      `The space sent more than ${maxTransferBytes} bytes, the limit of one transfer, so the transfer was stopped. Nothing reached the repository.`,
      { step: 'fetch into the quarantine', limit: maxTransferBytes },
    );
    const controller = new AbortController();
    let finished = false;
    let wake = () => {};
    const nextPoll = () => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, sizePollMs);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    const watch = (async () => {
      try {
        while (!finished) {
          if (await folderBytes(quarantine) > maxTransferBytes) {
            controller.abort(tooLarge());
            return;
          }
          await nextPoll();
        }
      } catch {
        return;
      }
    })();
    let fetched;
    try {
      fetched = await g.run(quarantine, [
        '-c', 'protocol.ext.allow=always', ...FETCH_CONFIG, ...QUARANTINE_CONFIG,
        'fetch', ...FETCH_FLAGS, '--update-shallow', url, `+${INSIDE_RESULT}:${QUARANTINE_RESULT}`,
      ], { timeoutMs, maxOutputBytes: FETCH_MAX_OUTPUT_BYTES, killTree: true, signal: controller.signal });
    } finally {
      finished = true;
      wake();
      await watch;
    }
    if (await folderBytes(quarantine) > maxTransferBytes) throw tooLarge();
    if (fetched.code !== 0) {
      throw new SpaceError('code_out_failed', `Fetching the result out of the space failed: ${tail(fetched.stderr) || `exit code ${fetched.code}`}`, { step: 'fetch into the quarantine', cause: null });
    }
  };

  const sizesOf = async (g: HostGit, where: string, ids: (string | undefined)[]) => new Map(parseSizes(await g.output(where, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    stdin: ids.map((id) => `${id}\n`).join(''),
    maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
    timeoutMs: APPLY_TIMEOUT_MS,
  })).map((object) => [object.id, object]));

  const measureChange = async (g: HostGit, where: string, from: string, to: string, { maxChangedBytes, maxChangedEntries, maxFolders, maxFolderSteps }: ChangeLimits & { maxFolders: number; maxFolderSteps: number }, refuse: ChangeRefusals, list = () => listChange(g, where, from, to)) => {
    let fields;
    try {
      fields = await list();
    } catch (error) {
      if (transferErrorProperty(error, 'code') === 'command_output_too_large') throw refuse.tooMany(`changes so many paths that their list is longer than ${LIST_MAX_OUTPUT_BYTES} bytes`, LIST_MAX_OUTPUT_BYTES);
      throw error;
    }
    const touched = [];
    const nested = [];
    const paths = [];
    const created = [];
    const deleted = [];
    const deletedLinks = [];
    let changedPaths = 0;
    let folders = 0;
    let steps = 0;
    let previous: string[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [oldMode, newMode, oldId, newId, status] = present(fields[index]).slice(1).split(' ');
      const file = present(fields[index + 1]);
      changedPaths += 1;
      if (changedPaths > maxChangedEntries) throw refuse.tooMany(`changes more than ${maxChangedEntries} paths`, maxChangedEntries);
      const names = file.split('/').slice(0, -1);
      let shared = 0;
      while (shared < names.length && shared < previous.length && names[shared] === previous[shared]) shared += 1;
      folders += names.length - shared;
      steps += (names.length * (names.length + 1) - shared * (shared + 1)) / 2 + names.length;
      if (folders > maxFolders) throw refuse.tooMany(`changes files in more than ${maxFolders} folders`, maxFolders);
      if (steps > maxFolderSteps) throw refuse.tooMany(`changes files so deep among so many folders that reaching them all takes more than ${maxFolderSteps} steps from a folder into the next`, maxFolderSteps);
      previous = names;
      paths.push(file);
      if (status === 'A') created.push(file);
      if (status === 'D') deleted.push(file);
      if (status === 'D' && oldMode === '120000') deletedLinks.push(file);
      if (status !== 'D' && newMode === '160000') nested.push(file);
      if (oldMode !== '160000' && !/^0+$/.test(String(oldId))) touched.push(oldId);
      if (status !== 'D' && newMode !== '160000') touched.push(newId);
    }
    const sizes = await sizesOf(g, where, [...new Set(touched)]);
    const changedBytes = touched.reduce((sum, id) => sum + present(sizes.get(id), 'size').size, 0);
    if (changedBytes > maxChangedBytes) throw refuse.tooLarge(changedBytes, maxChangedBytes);
    return { changedPaths, changedBytes, nestedRepositories: reported(nested), paths, created, deleted, deletedLinks };
  };

  const measureHistory = async (g: HostGit, quarantine: string, start: string, result: string, { maxChangedBytes, maxChangedEntries }: ChangeLimits, refuse: ChangeRefusals) => {
    let fresh;
    try {
      fresh = (await g.output(quarantine, ['rev-list', '--objects', '--no-object-names', result, '--not', start], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS })).split('\n').filter(Boolean);
    } catch (error) {
      if (transferErrorProperty(error, 'code') === 'command_output_too_large') throw refuse.tooMany(`brings so many objects that their list is longer than ${LIST_MAX_OUTPUT_BYTES} bytes`, LIST_MAX_OUTPUT_BYTES);
      throw error;
    }
    if (fresh.length > maxChangedEntries) throw refuse.tooMany(`brings more than ${maxChangedEntries} objects`, maxChangedEntries);
    const sizes = await sizesOf(g, quarantine, fresh);
    let newBytes = 0;
    for (const id of fresh) {
      const object = present(sizes.get(id), 'size');
      newBytes += object.size;
      if (object.type !== 'blob' && object.size > MAX_OBJECT_BYTES) {
        throw new SpaceError(
          'result_too_large',
          `The work of the space holds a ${object.type} of ${object.size} bytes, more than the ${MAX_OBJECT_BYTES} bytes one of those may hold. Nothing reached the repository.`,
          { step: 'measure the result', limit: MAX_OBJECT_BYTES, objectType: object.type, objectBytes: object.size },
        );
      }
    }
    if (newBytes > maxChangedBytes) throw refuse.tooLarge(newBytes, maxChangedBytes);
    return { newBytes };
  };

  const requireFetched = async (g: HostGit, where: string, ref: string, step: string, expected: string) => {
    const found = await readRef(g, where, ref);
    if (!found || found !== expected) {
      throw new SpaceError('result_ref_missing', 'The result did not arrive, or is not the one the space said it made. Nothing was changed.', { step, cause: null });
    }
    return found;
  };

  const bringCodeOut = (request: CodeOutRequest): Promise<CodeOutSummary> => withHostGit('code_out_failed', async (g, directory) => {
    const {
      repository, spaceId, spacePath: requestedPath, timeoutMs = FETCH_TIMEOUT_MS, innerMarginSeconds = INNER_MARGIN_SECONDS,
      maxTransferBytes = MAX_TRANSFER_BYTES, maxChangedBytes = MAX_CHANGED_BYTES, maxChangedEntries = MAX_CHANGED_ENTRIES,
    } = request ?? {};
    requireSpaceId(spaceId);
    const spacePath = requireSpaceProjectPath(spaceId, requestedPath);
    requireTimeout(timeoutMs);
    requireInnerMargin(innerMarginSeconds);
    const limits = { maxTransferBytes, maxChangedBytes, maxChangedEntries };
    for (const name of LIMIT_NAMES) requireLimit(limits[name], name);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const start = await requireStart(g, top, spaceId);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));

    const execArgv = await during('reach the space', () => present(place, 'execArgv').execArgv(spaceId));
    const reportedByTheSpace = await during('snapshot the space', async () => {
      const seconds = innerSeconds(SNAPSHOT_TIMEOUT_MS, innerMarginSeconds);
      const snapshot = await present(place, 'exec').exec(spaceId, [
        IMAGE_TIMEOUT, '-s', 'KILL', String(seconds), IMAGE_SH, '-c', SNAPSHOT_SCRIPT, 'sh',
        spacePath, UNCOMMITTED_MESSAGE, SNAPSHOT_IDENTITY.GIT_COMMITTER_NAME, SNAPSHOT_IDENTITY.GIT_COMMITTER_EMAIL,
      ], { timeoutMs: SNAPSHOT_TIMEOUT_MS });
      if (snapshot.code !== 0) {
        throw new SpaceError('code_out_failed', `Could not take the snapshot inside the space: ${tail(snapshot.stderr) || `exit code ${snapshot.code}`}`, { step: 'snapshot the space', cause: 'inside_command_failed', exitCode: snapshot.code });
      }
      const report = readReport(snapshot.stdout);
      if (!objectIdPattern(objectFormat).test(report.result)) {
        throw new SpaceError('code_out_failed', 'The space did not say which commit its snapshot made.', { step: 'snapshot the space', cause: 'inside_command_failed' });
      }
      return report;
    });

    const quarantine = path.join(directory, 'quarantine.git');
    const result = await during('fetch into the quarantine', async () => {
      await g.output(directory, ['init', '--quiet', '--bare', '--template=', `--object-format=${objectFormat}`, quarantine]);
      const objects = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-path', 'objects'])));
      await fs.mkdir(path.join(quarantine, 'objects', 'info'), { recursive: true });
      await fs.writeFile(path.join(quarantine, 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
      const url = buildExtUrl([...execArgv, IMAGE_TIMEOUT, '-s', 'KILL', String(innerSeconds(timeoutMs, innerMarginSeconds)), IMAGE_GIT, 'upload-pack', spacePath]);
      await fetchIntoQuarantine(g, quarantine, url, timeoutMs, maxTransferBytes);
      const fetched = await requireFetched(g, quarantine, QUARANTINE_RESULT, 'fetch into the quarantine', reportedByTheSpace.result);
      if (line(await g.output(quarantine, ['cat-file', '-t', fetched])) !== 'commit') {
        throw new SpaceError('result_not_a_commit', 'What the space offered as its result is not a commit. Nothing was changed.', { step: 'fetch into the quarantine' });
      }
      return fetched;
    });
    const summary = await during('measure the result', async () => {
      const refuse = {
        tooMany: (what: string, limit: number) => new SpaceError('result_too_many_changes', `The work of the space ${what}, the limit of one result. Nothing reached the repository.`, { step: 'measure the result', limit }),
        tooLarge: (bytes: number, limit: number) => new SpaceError('result_too_large', `The work of the space brings ${bytes} bytes, more than the limit of ${limit}. Nothing reached the repository.`, { step: 'measure the result', limit, newBytes: bytes }),
      };
      const { newBytes } = await measureHistory(g, quarantine, start, result, limits, refuse);
      const { paths: _paths, created: _created, deleted: _deleted, deletedLinks: _deletedLinks, ...change } = await measureChange(g, quarantine, start, result, {
        ...limits, maxChangedBytes: Number.MAX_SAFE_INTEGER, maxFolders: Number.MAX_SAFE_INTEGER, maxFolderSteps: Number.MAX_SAFE_INTEGER,
      }, refuse);
      return { ...change, newBytes };
    });

    await during('promote the result', async () => {
      const promoted = await g.run(top, [
        ...FETCH_CONFIG, 'fetch', ...FETCH_FLAGS, quarantine.replaceAll('\\', '/'), `+${QUARANTINE_RESULT}:${resultRef(spaceId)}`,
      ], { timeoutMs, maxOutputBytes: FETCH_MAX_OUTPUT_BYTES, killTree: true });
      if (promoted.code !== 0) {
        throw new SpaceError('code_out_failed', `Taking the result into the repository failed: ${tail(promoted.stderr) || `exit code ${promoted.code}`}`, { step: 'promote the result', cause: null });
      }
      await requireFetched(g, top, resultRef(spaceId), 'promote the result', result);
    });
    return { result, ...summary, unmerged: reportedByTheSpace.unmerged };
  });

  const requireBranchName = async (g: HostGit, top: string, branch: string) => {
    const text = String(branch ?? '');
    const refused = () => new SpaceError('invalid_branch_name', 'That name is not one git accepts for a new branch.');
    if (text !== branch || text === '' || text.startsWith('-') || EXT_UNCARRIABLE.test(text)) throw refused();
    const check = await g.run(top, ['check-ref-format', '--branch', text]);
    if (check.code !== 0 || line(check.stdout) !== text) throw refused();
    return text;
  };

  const applyAsBranch = (request: ApplyRequest & { branch: string }) => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId, branch } = request ?? {};
    requireSpaceId(spaceId);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    const name = await requireBranchName(g, top, branch);
    const result = await requireResult(g, top, spaceId);
    const objectFormat = line(await g.output(top, ['rev-parse', '--show-object-format']));
    const exists = () => new SpaceError('branch_exists', `A branch named ${name} already exists. Choose another name; the existing branch was not changed.`);
    if (await readRef(g, top, `refs/heads/${name}`)) throw exists();
    const created = await g.run(top, ['update-ref', '-m', `openchamber: work of space ${spaceId}`, `refs/heads/${name}`, result, zeroObjectId(objectFormat)]);
    if (created.code !== 0) {
      if (await readRef(g, top, `refs/heads/${name}`)) throw exists();
      const clash = await branchInTheWay(g, top, name);
      if (clash !== null) {
        throw new SpaceError('branch_exists', `A branch named ${clash} already exists, and git cannot keep a branch named ${name} beside it. Choose another name; the existing branch was not changed.`, { branch: clash });
      }
      throw new SpaceError('git_command_failed', `Could not create the branch ${name}: ${tail(created.stderr) || `exit code ${created.code}`}`, { exitCode: created.code });
    }
    return { branch: name, commit: result };
  });

  const branchInTheWay = async (g: HostGit, top: string, name: string) => {
    const folders = name.split('/').slice(0, -1);
    for (let depth = 1; depth <= folders.length; depth += 1) {
      const above = folders.slice(0, depth).join('/');
      if (await readRef(g, top, `refs/heads/${above}`)) return above;
    }
    const below = line(await g.output(top, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/heads/${name}/`]));
    return below === '' ? null : below.slice('refs/heads/'.length);
  };

  const readSetting = async (g: HostGit, top: string, key: string) => line((await g.run(top, ['config', '--bool', '--get', key])).stdout) === 'true';

  const exists = (full: string) => fs.lstat(full).then(() => true, () => false);

  const {
    startCall,
    readingBack,
    listed,
    patchOf,
    checkOf,
    readInterrupted,
    decideBase,
    filteredInTheWay,
    differFromHead,
  } = createCodeOutReadback({ files, readBackTimeoutMs });

  const describeApplyState = (request: ApplyRequest): Promise<ApplyState> => withHostGit('code_out_failed', async (g, directory): Promise<ApplyState> => {
    const { repository, spaceId } = request ?? {};
    requireSpaceId(spaceId);
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    return inTurn(await applyTurnKey(g, top, spaceId), async () => {
      const call = startCall(g, directory, top);
      const back = readingBack(call);
      const start = await requireStart(g, top, spaceId);
      const result = await readRef(g, top, resultRef(spaceId));
      const lastApplied = await readRef(g, top, appliedRef(spaceId));
      const closed = await readRef(g, top, closedRef(spaceId));
      const applying = closed ? null : await readRef(g, top, applyingRef(spaceId));
      let applied = lastApplied;
      let appliedFrom = applied ? await readRef(g, top, appliedFromRef(spaceId)) : null;
      let appliedHead = applied ? await readRef(g, top, appliedHeadRef(spaceId)) : null;
      let from = applied ?? start;
      let undecidedHere = false;
      if (result) {
        try {
          let interrupted = null;
          if (applying) {
            const recordedBase = await readRef(g, top, applyingFromRef(spaceId));
            const read = await readInterrupted(call, back, applying, recordedBase ?? lastApplied ?? start, [appliedFrom, start]);
            interrupted = read.state;
            if (interrupted === 'finished') {
              applied = applying;
              appliedFrom = read.base;
              appliedHead = await readRef(g, top, applyingHeadRef(spaceId));
            }
          }
          from = applied ?? start;
          if (!closed && interrupted !== 'partly') {
            const decision = await decideBase(call, back, { start, applied, appliedFrom, appliedHead, head: await readRef(g, top, 'HEAD') });
            from = decision.from ?? present(applied ?? undefined);
          }
        } catch (error) {
          if (transferErrorProperty(error, 'code') !== 'changes_undecided') throw error;
          undecidedHere = true;
        }
      }
      let newPaths = null;
      if (result && !undecidedHere) {
        try {
          const names = await g.output(top, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, result], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES, timeoutMs: APPLY_TIMEOUT_MS });
          newPaths = names.split('\0').filter(Boolean).length;
        } catch (error) {
          if (transferErrorProperty(error, 'code') !== 'command_output_too_large') throw error;
        }
      }
      return {
        changesRoute: closed ? 'closed' : 'open',
        result,
        lastApplied,
        newPaths,
        newPathsOverLimit: result !== null && newPaths === null && !undecidedHere,
        newPathsUndecided: undecidedHere,
        interruptedApply: applying !== null,
      };
    });
  });

  const applyAsChanges = (request: ApplyRequest): Promise<ApplyChangesResult> => withHostGit('code_out_failed', async (g, directory) => {
    const { repository, spaceId, maxChangedBytes = MAX_CHANGED_BYTES, maxChangedEntries = MAX_CHANGED_ENTRIES } = request ?? {};
    requireSpaceId(spaceId);
    requireLimit(maxChangedBytes, 'maxChangedBytes');
    requireLimit(maxChangedEntries, 'maxChangedEntries');
    await requireGitVersion(g, directory);
    const top = await requireWorkTree(g, repository);
    return inTurn(await applyTurnKey(g, top, spaceId), () => applyInTurn(startCall(g, directory, top), spaceId, { maxChangedBytes, maxChangedEntries }));
  });

  const preparePatch = async (call: ApplyCall, from: string, result: string, { maxChangedBytes, maxChangedEntries }: ChangeLimits) => {
    const { g, top } = call;
    const tooLarge = (what: string, limit: number) => new SpaceError(
      'changes_too_large',
      `The work of the space is too large to apply as uncommitted changes: it ${what}. Nothing was changed. Apply it as a branch instead.`,
      { limit },
    );
    const refuse = {
      tooMany: (what: string, limit: number) => tooLarge(what, limit),
      tooLarge: (bytes: number, limit: number) => tooLarge(`would read and write ${bytes} bytes, more than the limit of ${limit}`, limit),
    };
    const change = await measureChange(g, top, from, result, {
      maxChangedBytes, maxChangedEntries, maxFolders: maxChangedEntries, maxFolderSteps: maxChangedEntries * FOLDER_STEPS_PER_ENTRY,
    }, refuse, () => listed(call, g, from, result));
    if (change.changedPaths === 0) return { outcome: 'nothing' as const };
    const names = {
      ignoreCase: await readSetting(g, top, 'core.ignorecase'),
      precompose: await readSetting(g, top, 'core.precomposeunicode'),
    };
    if (change.created.length > 0) {
      const all = names.ignoreCase || names.precompose
        ? (await g.output(top, ['ls-tree', '-r', '-z', '--name-only', result], { maxOutputBytes: LIST_MAX_OUTPUT_BYTES })).split('\0').filter(Boolean)
        : [];
      const unholdable = nameNotAllowedHere(change.created, all, {
        platform, ...names, deleted: change.deleted, top, longPaths: await readSetting(g, top, 'core.longpaths'),
      });
      if (unholdable !== null) {
        const [shown, other] = reported([unholdable.path, unholdable.other ?? '']).paths;
        const details = { path: shown, rule: unholdable.rule, other: other ?? null };
        if (unholdable.rule === 'case_only_rename') {
          throw new SpaceError(
            'case_only_rename',
            `The agent renamed ${other} to ${shown}, changing only the case of the name, and on this computer that cannot be applied as uncommitted changes, so nothing was changed. The branch holds it: apply the work as a branch, or have the agent choose a new name and bring the work out again.`,
            details,
          );
        }
        const why = new Map([
          ['differs_only_in_case', `differs from ${other} only in case, and this computer takes the two for one file`],
          ['path_too_long', 'is a path too long for this computer, in your project\'s folder'],
        ]).get(unholdable.rule) ?? 'has a name this computer cannot hold';
        throw new SpaceError(
          'name_not_allowed_here',
          `The agent made ${shown}, which ${why}, so nothing was changed. Have the agent rename it, then bring the work out again.`,
          details,
        );
      }
    }
    const redirected = await firstRedirectedFolder(top, change.paths, { ...names, deletedLinks: change.deletedLinks });
    if (redirected !== null) return { outcome: 'blocked' as const, folder: redirected };
    let patch;
    try {
      patch = await patchOf(call, g, from, result);
    } catch (error) {
      throw new SpaceError(
        'patch_not_possible',
        `A patch of the work of the space could not be built, so nothing was changed. Apply it as a branch instead. Git said: ${transferErrorProperty(error, 'message')}`,
        { cause: transferErrorProperty(error, 'code') ?? null },
      );
    }
    try {
      return { outcome: 'checked' as const, change, patch: patch.file, check: await checkOf(call, g, from, result) };
    } catch (error) {
      if (transferErrorProperty(error, 'code') === 'command_timeout') return { outcome: 'slow' as const };
      throw error;
    }
  };

  const someOf = ({ count, paths }: ReportedPaths) => {
    const named = paths.slice(0, 3);
    if (count > named.length) return `${named.join(', ')} and ${count - named.length} more`;
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  };

  const applyInTurn = async (call: ApplyCall, spaceId: string, caps: ChangeLimits): Promise<ApplyChangesResult> => {
    const { g, top } = call;
    const start = await requireStart(g, top, spaceId);
    const result = await requireResult(g, top, spaceId);
    if (await readRef(g, top, closedRef(spaceId))) {
      throw new SpaceError(
        'changes_route_closed',
        `The work of this space is no longer applied as uncommitted changes: it and your project went apart. ${BRANCH_FROM_NOW_ON}`,
      );
    }
    const closing = `openchamber: the work of space ${spaceId} is applied as a branch now`;
    const close = () => g.run(top, ['update-ref', '-m', closing, closedRef(spaceId), result]);
    const forgetIntent = (at: string, base: string | null, head: string | null) => [
      `delete ${applyingRef(spaceId)} ${at}\n`,
      base ? `delete ${applyingFromRef(spaceId)} ${base}\n` : '',
      head ? `delete ${applyingHeadRef(spaceId)} ${head}\n` : '',
    ].join('');
    const closeAndForget = async (at: string, base: string | null, head: string | null) => (await g.run(top, ['update-ref', '-m', closing, '--stdin'], {
      stdin: `update ${closedRef(spaceId)} ${at}\n${forgetIntent(at, base, head)}`,
    })).code === 0;
    const headRecord = (head: string | null) => (head ? `update ${appliedHeadRef(spaceId)} ${head}\n` : `delete ${appliedHeadRef(spaceId)}\n`);
    let applied = await readRef(g, top, appliedRef(spaceId));
    let appliedFrom = applied ? await readRef(g, top, appliedFromRef(spaceId)) : null;
    let appliedHead = applied ? await readRef(g, top, appliedHeadRef(spaceId)) : null;
    const head = await readRef(g, top, 'HEAD');
    const back = readingBack(call);
    let intent = null;
    const applying = await readRef(g, top, applyingRef(spaceId));
    if (applying) intent = { at: applying, base: await readRef(g, top, applyingFromRef(spaceId)), head: await readRef(g, top, applyingHeadRef(spaceId)) };
    let decision;
    try {
      if (intent) {
        const { state, base } = await readInterrupted(call, back, intent.at, intent.base ?? applied ?? start, [appliedFrom, start]);
        if (state === 'partly') {
          const recorded = await closeAndForget(intent.at, intent.base, intent.head);
          throw new SpaceError(
            'changes_partly_applied',
            `An earlier apply of the work of this space was interrupted, and part of it is in your project: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON}`,
            { interrupted: true, recorded },
          );
        }
        const record = state === 'finished'
          ? `update ${appliedRef(spaceId)} ${intent.at}\nupdate ${appliedFromRef(spaceId)} ${base}\n${headRecord(intent.head)}${forgetIntent(intent.at, intent.base, intent.head)}`
          : forgetIntent(intent.at, intent.base, intent.head);
        await g.output(top, ['update-ref', '-m', `openchamber: sorted out an interrupted apply of space ${spaceId}`, '--stdin'], { stdin: record });
        if (state === 'finished') {
          applied = intent.at;
          appliedFrom = base;
          appliedHead = intent.head;
        }
        intent = null;
      }
      decision = await decideBase(call, back, { start, applied, appliedFrom, appliedHead, head });
    } catch (error) {
      if (transferErrorProperty(error, 'code') !== 'changes_undecided') throw error;
      const recorded = intent ? await closeAndForget(intent.at, intent.base, intent.head) : (await close()).code === 0;
      throw new SpaceError('changes_undecided', `${transferErrorProperty(error, 'message')} So nothing was changed. ${BRANCH_FROM_NOW_ON}`, withTransferErrorDetails(transferErrorProperty(error, 'details'), { recorded }));
    }
    if (decision.partly) {
      await close();
      const gone = reported(decision.partly.gone);
      const kept = reported(decision.partly.stillThere);
      const inTheWay = await differFromHead(call, back, head, decision.partly.stillThere).catch(() => true);
      throw new SpaceError(
        'changes_do_not_apply',
        `You threw away part of what was last applied from this space: ${someOf(gone)} ${gone.count === 1 ? 'is' : 'are'} back as before, while ${someOf(kept)} ${kept.count === 1 ? 'is' : 'are'} still there or changed since. An apply now would leave out what you threw away without a word, so nothing was changed. ${BRANCH_FROM_NOW_ON}${inTheWay ? ' Before you merge that branch or switch to it, remove or commit the files of this space that are still in your project, or git will refuse.' : ''}`,
        { thrownAway: gone, stillThere: kept },
      );
    }
    const { from } = decision;
    const prepared = await preparePatch(call, from, result, caps);
    if (prepared.outcome === 'nothing') return { status: 'nothing_to_apply' };
    if (prepared.outcome === 'blocked') {
      await close();
      const shown = reported([prepared.folder]).paths[0];
      throw new SpaceError(
        'changes_blocked_by_link',
        `The work of the space writes into ${shown}, which in your project is a link to another place, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
        { path: shown },
      );
    }
    if (prepared.outcome === 'slow') {
      await close();
      throw new SpaceError(
        'changes_undecided',
        `Checking whether the work of the space fits your project took longer than ${APPLY_TIMEOUT_MS / 1000} seconds, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
        { limitMs: APPLY_TIMEOUT_MS },
      );
    }
    const { change, patch, check } = prepared;
    if (check.code !== 0) {
      await close();
      const inTheWay = [];
      for (const file of change.created) {
        if (await exists(path.join(top, ...file.split('/')))) inTheWay.push(file);
      }
      const asked = inTheWay.length === 0 ? null : await g.run(top, ['check-ignore', '-z', '--stdin'], {
        stdin: inTheWay.map((file) => `${file}\0`).join(''), maxOutputBytes: LIST_MAX_OUTPUT_BYTES,
      }).catch(() => null);
      const ignored = asked === null ? [] : asked.stdout.split('\0').filter(Boolean);
      const said = `Git said: ${tail(check.stderr) || `exit code ${check.code}`}`;
      const filtered = ignored.length > 0 ? [] : await filteredInTheWay(call, readingBack(call), from, result).catch(() => []);
      if (filtered.length > 0) {
        const shown = reported(filtered);
        throw new SpaceError(
          'changes_do_not_apply',
          `The work of the space changes ${someOf(shown)} again, which a filter such as Git LFS handles in your project. Files like that cannot be updated as uncommitted changes a second time, so nothing was changed. ${BRANCH_FROM_NOW_ON}`,
          { exitCode: check.code, filteredInTheWay: shown },
        );
      }
      if (ignored.length > 0) {
        throw new SpaceError(
          'changes_do_not_apply',
          `Your project already has ${reported(ignored).paths[0]}, which git ignores here, and the work of the space adds a file of the same name, so nothing was changed. ${BRANCH_FROM_NOW_ON} ${said}`,
          { exitCode: check.code, ignoredInTheWay: reported(ignored) },
        );
      }
      const since = from === start ? 'since the space was made' : 'since its work was last applied here';
      throw new SpaceError(
        'changes_do_not_apply',
        `The work of the space does not fit your project any more: your project changed ${since}, so nothing was changed now. ${BRANCH_FROM_NOW_ON} ${said}`,
        { exitCode: check.code },
      );
    }
    await g.output(top, ['update-ref', '-m', `openchamber: applying the work of space ${spaceId}`, '--stdin'], {
      stdin: `update ${applyingRef(spaceId)} ${result}\nupdate ${applyingFromRef(spaceId)} ${from}\n${head ? `update ${applyingHeadRef(spaceId)} ${head}\n` : ''}`,
    });
    const done = await g.run(top, [...APPLY_ARGS, patch], {
      timeoutMs: APPLY_TIMEOUT_MS, maxOutputBytes: APPLY_OUTPUT_TAIL_BYTES, keepTail: true, killTree: true, keepAtExit: true,
    });
    if (done.code !== 0) {
      const recorded = await closeAndForget(result, from, head);
      throw new SpaceError(
        'changes_partly_applied',
        `Applying the work of the space stopped in the middle, so part of it may be in your project already: look at what changed. Your project is now in a state this cannot reason about. ${BRANCH_FROM_NOW_ON} Git said: ${tail(done.stderr) || `exit code ${done.code}`}`,
        { exitCode: done.code, recorded },
      );
    }
    const remembered = await g.run(top, ['update-ref', '-m', `openchamber: applied the work of space ${spaceId}`, '--stdin'], {
      stdin: `update ${appliedRef(spaceId)} ${result}\nupdate ${appliedFromRef(spaceId)} ${from}\n${headRecord(head)}${forgetIntent(result, from, head)}`,
    });
    return {
      status: 'applied',
      appliedPaths: change.changedPaths,
      remembered: remembered.code === 0,
      nestedRepositories: change.nestedRepositories,
      conflicted: await conflictedPaths(patch),
    };
  };

  const applyTurnKey = async (g: HostGit, top: string, spaceId: string) => {
    const common = path.resolve(top, line(await g.output(top, ['rev-parse', '--git-common-dir'])));
    return `${await fs.realpath(common)}\0${spaceId}`;
  };

  return { bringCodeOut, applyAsBranch, applyAsChanges, describeApplyState };
}
