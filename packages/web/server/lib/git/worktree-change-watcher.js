import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const resolveGitCommonDirectory = async (directory) => {
  const { stdout: rootOutput } = await execFile('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = String(rootOutput || '').trim();
  const { stdout: commonOutput } = await execFile('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const common = String(commonOutput || '').trim();
  if (!root || !common) throw new Error('Failed to resolve git common directory');
  return path.resolve(common);
};

export async function watchWorktreeChanges(directory, onChange) {
  if (typeof onChange !== 'function') throw new Error('Worktree change callback is required');
  const commonGitDir = await resolveGitCommonDirectory(directory);
  const worktreesDir = path.join(commonGitDir, 'worktrees');
  const watchers = [];
  let closed = false;
  let debounceTimer = null;
  let worktreesWatcher = null;
  let worktreesWatchIno = null;

  const notify = (reason) => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange({ reason, commonGitDir, worktreesDir, at: Date.now() });
    }, 200);
  };

  const closeWatcher = (watcher) => {
    try { watcher.close(); } catch {}
  };
  const removeWatcher = (watcher) => {
    const index = watchers.indexOf(watcher);
    if (index !== -1) watchers.splice(index, 1);
    closeWatcher(watcher);
  };
  const attachWatcher = (targetPath, handler) => {
    let stat;
    try { stat = fs.statSync(targetPath); } catch { return null; }
    if (!stat.isDirectory()) return null;
    const watcher = fs.watch(targetPath, { persistent: false }, (eventType, filename) => {
      handler(eventType, typeof filename === 'string' ? filename : null);
    });
    watcher.on('error', (error) => console.warn('Git worktree watcher error:', error?.message || error));
    watchers.push(watcher);
    return watcher;
  };
  const syncWorktreesWatcher = () => {
    if (closed) return false;
    let stat;
    try { stat = fs.statSync(worktreesDir); } catch { stat = null; }
    if (!stat?.isDirectory()) {
      if (!worktreesWatcher) return false;
      removeWatcher(worktreesWatcher);
      worktreesWatcher = null;
      worktreesWatchIno = null;
      return true;
    }
    if (worktreesWatcher && worktreesWatchIno === stat.ino) return false;
    if (worktreesWatcher) removeWatcher(worktreesWatcher);
    worktreesWatcher = attachWatcher(worktreesDir, () => notify('worktrees-directory-changed'));
    worktreesWatchIno = worktreesWatcher ? stat.ino : null;
    return Boolean(worktreesWatcher);
  };

  attachWatcher(commonGitDir, (_eventType, filename) => {
    if (filename === 'worktrees') {
      syncWorktreesWatcher();
      notify('common-git-directory-changed');
    } else if (!filename && syncWorktreesWatcher()) {
      notify('common-git-directory-changed');
    }
  });
  syncWorktreesWatcher();
  if (watchers.length === 0) throw new Error('Failed to watch git worktree metadata');

  return () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    watchers.splice(0).forEach(closeWatcher);
  };
}
