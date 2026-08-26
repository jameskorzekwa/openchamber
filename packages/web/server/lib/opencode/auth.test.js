import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeDataDir } from './auth.js';

describe('resolveOpenCodeDataDir', () => {
  it('prefers the explicit OpenCode data directory', () => {
    const existsSync = vi.fn();

    expect(resolveOpenCodeDataDir({
      env: { OPENCODE_DATA_DIR: '/srv/opencode', XDG_DATA_HOME: '/srv/xdg' },
      homeDir: '/home/tester',
      existsSync,
    })).toBe(path.resolve('/srv/opencode'));
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('uses the XDG data directory when configured', () => {
    const existsSync = vi.fn();

    expect(resolveOpenCodeDataDir({
      env: { XDG_DATA_HOME: '/srv/xdg' },
      homeDir: '/home/tester',
      existsSync,
    })).toBe(path.resolve('/srv/xdg/opencode'));
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('detects the nested migrated data directory by its auth file', () => {
    const homeDir = path.resolve('/home/tester');
    const migratedDataDir = path.join(homeDir, '.local', 'share', 'opencode', 'xdg', 'opencode');
    const existsSync = vi.fn((candidate) => candidate === path.join(migratedDataDir, 'auth.json'));

    expect(resolveOpenCodeDataDir({ env: {}, homeDir, existsSync })).toBe(migratedDataDir);
  });

  it('keeps the legacy data directory when no migrated auth file exists', () => {
    const homeDir = path.resolve('/home/tester');

    expect(resolveOpenCodeDataDir({
      env: {},
      homeDir,
      existsSync: () => false,
    })).toBe(path.join(homeDir, '.local', 'share', 'opencode'));
  });
});
