import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSource = (relativeUrl: string) => readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');

describe('OPM status overlay shell mounts', () => {
  test('mounts in connected desktop and mobile shells but not VS Code', () => {
    const mainLayout = readSource('../layout/MainLayout.tsx');
    const mobileApp = readSource('../../apps/MobileApp.tsx');
    const vscodeLayout = readSource('../layout/VSCodeLayout.tsx');

    expect(mainLayout).toContain('<OpmStatusOverlay />');
    expect(/<RuntimeAPIProvider[\s\S]*<OpmStatusOverlay \/>[\s\S]*<\/RuntimeAPIProvider>/.test(mobileApp)).toBe(true);
    expect(mobileApp.indexOf('<OpmStatusOverlay />')).toBeGreaterThan(mobileApp.indexOf('if (!isConnected && !isReconnecting)'));
    expect(vscodeLayout).not.toContain('OpmStatusOverlay');
  });
});
