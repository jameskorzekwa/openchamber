import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { OpmSettingsPanel } from './OpmSettingsPanel';
import type { OpmSettings, OpmConfiguration, SettingsResult } from './opm-settings';

const view = (): OpmSettings => ({
  revision: 'revision-one',
  config: { paused: true, projects: [{ slug: 'alpha', enabled: true, providerConfig: { ownerIdentity: 'local:james' } }] },
  effective: { paused: true, projects: [{ slug: 'alpha', enabled: true, agent: 'build', model: '', fallbackModels: [], providerConfig: { ownerIdentity: 'local:james' } }] },
  defaults: { paused: false, pollSeconds: 20, controlPort: 47651, requireMountedWorkspaceVolume: false },
  keys: { global: ['paused', 'pollSeconds', 'controlPort', 'requireMountedWorkspaceVolume', 'projects'], project: ['slug', 'enabled', 'agent', 'model', 'fallbackModels', 'providerConfig'], providerConfig: ['ownerIdentity'], policy: [], overrides: [] },
  fieldKinds: { global: { paused: 'boolean', pollSeconds: 'number', controlPort: 'number', requireMountedWorkspaceVolume: 'boolean' }, project: { slug: 'string', enabled: 'boolean', agent: 'string', model: 'string', fallbackModels: 'json' }, providerConfig: { ownerIdentity: 'string' } },
  restartRequiredKeys: ['controlPort', 'requireMountedWorkspaceVolume'], restartRequired: [],
  projects: [{ slug: 'alpha', inherited: { agent: { source: 'global', value: 'build' } } }],
});

describe('OPM settings editor', () => {
  let browser: Window;
  let root: Root;
  beforeEach(async () => {
    browser = new Window();
    Object.assign(globalThis, {
      window: browser, document: browser.document, navigator: browser.navigator,
      HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
      HTMLInputElement: browser.HTMLInputElement, Event: browser.Event,
      localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); browser.close(); });
  const click = async (text: string) => {
    const target = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find((element) => element.textContent?.startsWith(text));
    if (!target) throw new Error(`Missing control: ${text}`);
    await act(async () => target.click());
  };
  const mount = async (saveSettings: (config: OpmConfiguration, revision: string, confirmation?: string) => Promise<SettingsResult>, payload = view()) => {
    await act(async () => root.render(<I18nProvider><OpmSettingsPanel loadSettings={async () => payload} saveSettings={saveSettings} /></I18nProvider>));
  };

  test('admission is independent from pause and saves through the authoritative revision', async () => {
    const writes: OpmConfiguration[] = [];
    await mount(async (config, revision) => {
      expect(revision).toBe('revision-one');
      writes.push(config);
      return { applied: true, saved: true, revision: 'revision-two' };
    });
    expect(document.body.textContent).toContain('Off: existing work continues, but no new issues are admitted.');
    expect(document.body.textContent).toContain('Effective agent: "build". Source: global.');
    await click('Admit new work');
    await click('Validate and apply');
    expect(writes).toHaveLength(1);
    expect(writes[0].projects[0].enabled).toBe(false);
    expect(writes[0].paused).toBe(true);
    expect(document.body.textContent).toContain('Applied to running supervisor');
  });

  test('rejected save retains the draft and displays the server error', async () => {
    await mount(async () => { throw new Error('Configuration changed; reload settings before saving'); });
    await click('Admit new work');
    await click('Validate and apply');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Configuration changed');
    const admission = [...document.querySelectorAll('[role="button"]')].find((element) => element.textContent?.startsWith('Admit new work'));
    expect(admission?.getAttribute('aria-pressed')).toBe('false');
    expect(document.body.textContent).not.toContain('Applied to running supervisor');
  });

  test('sensitive changes require a separate exact-candidate confirmation', async () => {
    const confirmations: (string | undefined)[] = [];
    await mount(async (_config, _revision, confirmation) => {
      confirmations.push(confirmation);
      return confirmation ? { applied: true, saved: true, revision: 'two' } : { applied: false, confirmationRequired: ['projects.alpha.policy'], confirmation: 'candidate-digest' };
    });
    await click('Validate and apply');
    expect(confirmations).toEqual([undefined]);
    expect(document.body.textContent).toContain('projects.alpha.policy');
    await click('Confirm sensitive changes');
    expect(confirmations).toEqual([undefined, 'candidate-digest']);
    expect(document.body.textContent).toContain('Applied to running supervisor');
  });

  test('restart-only save never claims live application and marks boolean infrastructure too', async () => {
    await mount(async () => ({ applied: false, saved: true, revision: 'two', restartRequired: ['controlPort'] }));
    expect(document.body.textContent?.match(/Requires supervisor restart/g)).toHaveLength(2);
    await click('Validate and apply');
    expect(document.body.textContent).toContain('Restart required: controlPort. Saved changes are not yet applied.');
    expect(document.body.textContent).not.toContain('Applied to running supervisor');
  });

  test('unavailable settings are an error, not an empty configuration', async () => {
    await act(async () => root.render(<I18nProvider><OpmSettingsPanel loadSettings={async () => { throw new Error('Settings unavailable'); }} /></I18nProvider>));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Settings unavailable');
    expect(document.body.textContent).not.toContain('Validate and apply');
  });

  test('new project setup remains open after its first slug character', async () => {
    const writes: OpmConfiguration[] = [];
    await mount(async (config) => { writes.push(config); return { applied: true }; });
    await click('Add project');
    const inputs = document.querySelectorAll<HTMLInputElement>('[aria-label="slug"]');
    const input = inputs[inputs.length - 1];
    if (!input) throw new Error('Missing new project slug');
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set?.call(input, 'n');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.closest('details')?.open).toBe(true);
    await click('Validate and apply');
    expect(writes[0].projects[1].slug).toBe('n');
    expect(writes[0].projects[1].enabled).toBe(false);
  });

  test('runtime switching aborts the old settings load before it can publish', async () => {
    let signal: AbortSignal | undefined;
    let finish: (value: OpmSettings) => void = () => { throw new Error('loader did not start'); };
    const loadSettings = (nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return new Promise<OpmSettings>((resolve) => { finish = resolve; });
    };
    await act(async () => root.render(<I18nProvider><OpmSettingsPanel loadSettings={loadSettings} /></I18nProvider>));
    await act(async () => {
      browser.dispatchEvent(new browser.CustomEvent('openchamber:runtime-endpoint-will-change'));
      finish(view());
    });
    expect(signal?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain('Admit new work');
  });
});
