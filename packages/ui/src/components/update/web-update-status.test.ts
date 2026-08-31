import { describe, expect, test } from 'bun:test';
import { canManuallyCheckForUpdate, canStartWebUpdate, parseWebUpdateInstallationStatus } from './web-update-status';

describe('parseWebUpdateInstallationStatus', () => {
  for (const state of ['available', 'downloading', 'installing', 'restarting', 'installed', 'failed', 'rollback', 'no-validated-release'] as const) {
    test(`accepts the ${state} lifecycle state`, () => {
      expect(parseWebUpdateInstallationStatus({
        schemaVersion: 1,
        state,
        currentVersion: '1.0.0',
        targetVersion: '2.0.0',
        previousVersion: null,
        error: null,
        updatedAt: '2026-08-26T00:00:00.000Z',
      })?.state).toBe(state);
    });
  }

  test('rejects malformed and unknown status payloads', () => {
    expect(parseWebUpdateInstallationStatus(JSON.parse('{"state":"success","currentVersion":"2.0.0"}'))).toBeNull();
    expect(parseWebUpdateInstallationStatus(JSON.parse('{"state":"installed","currentVersion":2,"targetVersion":null,"previousVersion":null,"error":null}'))).toBeNull();
    expect(parseWebUpdateInstallationStatus(JSON.parse('null'))).toBeNull();
  });

  test('never offers installation when no validated release exists', () => {
    expect(canStartWebUpdate('no-validated-release')).toBe(false);
    expect(canStartWebUpdate('available')).toBe(true);
  });

  test('keeps manual checks available when no validated release is recorded', () => {
    expect(canManuallyCheckForUpdate(false, null)).toBe(true);
    expect(canManuallyCheckForUpdate(true, null)).toBe(false);
    expect(canManuallyCheckForUpdate(false, 'network failed')).toBe(false);
  });
});
