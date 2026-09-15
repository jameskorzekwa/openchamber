import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsCheckboxRow, SettingsSection, SettingsStackedField, SETTINGS_FIELDS_STACK_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { fetchOpmSettings, saveOpmSettings, settingObject, type OpmSettings, type OpmConfiguration, type SettingValue, type SettingsResult } from './opm-settings';

function SettingField({ name, kind, value, fallback, restart, disabled, info, onChange, onValidity }: {
  name: string; value: SettingValue | undefined; fallback?: SettingValue;
  kind: 'json' | 'number' | 'boolean' | 'string';
  info?: string;
  restart: boolean; disabled: boolean;
  onChange: (value: SettingValue | undefined) => void;
  onValidity: (valid: boolean) => void;
}) {
  const { t } = useI18n();
  const json = kind === 'json' || kind === 'number';
  const [text, setText] = React.useState(() => value === undefined ? '' : json ? JSON.stringify(value, null, 2) : String(value ?? ''));
  const [invalid, setInvalid] = React.useState(false);
  if (kind === 'boolean') {
    return <SettingsCheckboxRow label={name === 'paused' ? t('opm.pause.pause') : name} ariaLabel={name === 'paused' ? t('opm.pause.pause') : name} description={restart ? t('opm.settings.restartLabel') : undefined} checked={value === undefined ? fallback === true : value === true} disabled={disabled} onChange={onChange} />;
  }
  const update = (next: string) => {
    setText(next);
    try {
      const parsed = next === '' ? undefined : json ? z.json().parse(JSON.parse(next)) : next;
      onChange(parsed);
      setInvalid(false);
      onValidity(true);
    } catch {
      setInvalid(true);
      onValidity(false);
    }
  };
  return <SettingsStackedField label={name} info={info} description={restart ? t('opm.settings.restartLabel') : undefined}>
    {kind === 'json'
      ? <Textarea aria-label={name} value={text} placeholder={fallback === undefined ? '' : JSON.stringify(fallback, null, 2)} disabled={disabled} aria-invalid={invalid} onChange={(event) => update(event.target.value)} className="max-w-[24rem] font-mono" />
      : <Input aria-label={name} value={text} disabled={disabled} aria-invalid={invalid} placeholder={fallback === undefined ? '' : String(fallback ?? '')} onChange={(event) => update(event.target.value)} className="h-9 max-w-[24rem]" />}
    {invalid ? <p role="alert" className="text-status-error">{t('opm.settings.invalid', { field: name })}</p> : null}
  </SettingsStackedField>;
}

function SettingsEditor({ initial, reload, loadSettings, saveSettings }: {
  initial: OpmSettings; reload: () => void;
  loadSettings: typeof fetchOpmSettings; saveSettings: typeof saveOpmSettings;
}) {
  const { t } = useI18n();
  const [config, setConfig] = React.useState<OpmConfiguration>(() => structuredClone(initial.config));
  const [projectKeys, setProjectKeys] = React.useState(() => initial.config.projects.map((_project, index) => index));
  const nextProjectKey = React.useRef(initial.config.projects.length);
  const [invalid, setInvalid] = React.useState<Set<string>>(() => new Set());
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<SettingsResult | null>(null);
  const [revision, setRevision] = React.useState(initial.revision);
  const [observed, setObserved] = React.useState(initial);
  const change = (next: OpmConfiguration) => { setConfig(next); setResult(null); setError(null); };
  const fields = (keys: string[], values: { [key: string]: SettingValue }, defaults: { [key: string]: SettingValue }, prefix: string, update: (next: { [key: string]: SettingValue }) => void) => keys.map((name) => (
    <SettingField key={`${prefix}.${name}`} name={name} kind={initial.fieldKinds[prefix === 'global' ? 'global' : prefix.endsWith('.policy') ? 'policy' : prefix.endsWith('.overrides') ? 'overrides' : prefix.endsWith('.providerConfig') ? 'providerConfig' : 'project'][name]} value={values[name]} fallback={defaults[name]} disabled={pending}
      info={name === 'openChamberRelease' ? [...(initial.keys[name] ?? []), ...(initial.keys.jobs ?? []).map((key) => `jobs[].${key}`)].join(', ') : initial.keys[name]?.join(', ')}
      restart={prefix === 'global' && initial.restartRequiredKeys.includes(name)}
      onValidity={(valid) => setInvalid((prior) => { const next = new Set(prior); if (valid) next.delete(`${prefix}.${name}`); else next.add(`${prefix}.${name}`); return next; })}
      onChange={(value) => { const next = { ...values }; if (value === undefined) delete next[name]; else next[name] = value; update(next); }} />
  ));
  const save = async (confirmation?: string) => {
    setPending(true); setError(null); reportSettingsSaveState('saving');
    try {
      const saved = await saveSettings(config, revision, confirmation);
      setResult(saved);
      if (saved.revision) setRevision(saved.revision);
      reportSettingsSaveState('saved');
      if (saved.saved) setObserved(await loadSettings());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      reportSettingsSaveState('error');
    } finally { setPending(false); }
  };
  return <div className="@container">
    <p className="typography-meta text-muted-foreground">{t('opm.settings.syntax')}</p>
    <div className="my-4 flex flex-wrap gap-2">
      <Button disabled={pending || invalid.size > 0} onClick={() => void save()}>{pending ? t('common.loading') : t('opm.settings.save')}</Button>
      <Button variant="outline" disabled={pending} onClick={reload}>{t('opm.settings.reload')}</Button>
    </div>
    {result?.confirmationRequired ? <SettingsSection title={t('opm.settings.confirm')} description={result.confirmationRequired.join(', ')}>
      <Button disabled={pending || invalid.size > 0} onClick={() => void save(result.confirmation)}>{t('opm.settings.confirm')}</Button>
    </SettingsSection> : null}
    {result?.applied ? <p role="status">{t('opm.settings.applied')}</p> : null}
    {(result?.restartRequired ?? observed.restartRequired).length > 0 ? <p role="status" className="text-status-warning">{t('opm.settings.restart', { fields: (result?.restartRequired ?? observed.restartRequired).join(', ') })}</p> : null}
    {error ? <p role="alert" className="text-status-error">{error}</p> : null}
    {config.projects.map((project, index) => {
      const update = (next: { [key: string]: SettingValue }) => {
        const projects = [...config.projects];
        projects[index] = { ...next, slug: z.string().parse(next.slug ?? '') };
        change({ ...config, projects });
      };
      const effective = observed.effective.projects.find((entry) => entry.slug === project.slug);
      const providerConfig = settingObject(project.providerConfig);
      return <SettingsSection key={projectKeys[index]} title={String(project.name || project.slug) || t('settings.projects.sidebar.actions.addProject')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}
        headerAction={<Button variant="outline" size="sm" disabled={pending || invalid.size > 0} onClick={() => {
          setProjectKeys((keys) => keys.filter((_key, position) => position !== index));
          change({ ...config, projects: config.projects.filter((_entry, position) => position !== index) });
        }}>{t('settings.remoteInstances.sidebar.actions.remove')}</Button>}>
        <SettingsCheckboxRow label={t('opm.settings.admit')} ariaLabel={t('opm.settings.admit')} description={t('opm.settings.admitHelp')} checked={project.enabled !== false} disabled={pending} onChange={(enabled) => update({ ...project, enabled })} />
        {fields(['agent', 'model', 'fallbackModels'], project, effective ?? {}, `projects.${index}`, update)}
        {Object.entries(observed.projects.find((entry) => entry.slug === project.slug)?.inherited ?? {}).map(([field, inherited]) =>
          <p key={field} className="typography-meta text-muted-foreground">{t('opm.settings.inherit', { field, value: JSON.stringify(inherited.value), source: inherited.source })}</p>)}
        <details open={projectKeys[index] >= initial.config.projects.length || undefined}>
          <summary className="cursor-pointer">{t('opm.settings.advanced')}</summary>
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {fields(initial.keys.project.filter((key) => !['enabled', 'agent', 'model', 'fallbackModels', 'providerConfig', 'policy', 'overrides'].includes(key)), project, effective ?? {}, `projects.${index}`, update)}
            {(['policy', 'overrides'] as const).map((group) => <SettingsSection key={`${group}:${project[group] === undefined}`} title={group} contentClassName={SETTINGS_FIELDS_STACK_CLASS}
              headerAction={<Button variant="outline" size="sm" disabled={pending} onClick={() => {
                const next = { ...project }; delete next[group]; update(next);
                setInvalid((prior) => new Set([...prior].filter((key) => !key.startsWith(`projects.${index}.${group}.`))));
              }}>{t('settings.common.actions.reset')}</Button>}>
              {fields(initial.keys[group], settingObject(project[group]), settingObject(effective?.[group]), `projects.${index}.${group}`, (value) => update({ ...project, [group]: value }))}
            </SettingsSection>)}
            {fields(initial.keys.providerConfig.filter((key) => key !== 'policy'), providerConfig, settingObject(effective?.providerConfig), `projects.${index}.providerConfig`, (value) => update({ ...project, providerConfig: value }))}
            <SettingsSection title="providerConfig.policy" key={`provider-policy:${providerConfig.policy === undefined}`} contentClassName={SETTINGS_FIELDS_STACK_CLASS}
              headerAction={<Button variant="outline" size="sm" disabled={pending} onClick={() => {
                const next = { ...providerConfig }; delete next.policy; update({ ...project, providerConfig: next });
                setInvalid((prior) => new Set([...prior].filter((key) => !key.startsWith(`projects.${index}.providerConfig.policy.`))));
              }}>{t('settings.common.actions.reset')}</Button>}>
              {fields(initial.keys.policy, settingObject(providerConfig.policy), settingObject(effective?.policy), `projects.${index}.providerConfig.policy`, (policy) => update({ ...project, providerConfig: { ...providerConfig, policy } }))}
            </SettingsSection>
          </div>
        </details>
      </SettingsSection>;
    })}
    <Button variant="outline" disabled={pending || invalid.size > 0} onClick={() => {
      const key = nextProjectKey.current++;
      setProjectKeys((keys) => [...keys, key]);
      change({ ...config, projects: [...config.projects, { slug: '', rootPath: '', preset: 'plain', enabled: false, providerConfig: { ownerIdentity: '' } }] });
    }}>{t('settings.projects.sidebar.actions.addProject')}</Button>
    <SettingsSection title={t('opm.settings.global')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
      {fields(initial.keys.global.filter((key) => key !== 'projects' && !initial.restartRequiredKeys.includes(key)), config, initial.defaults, 'global', (next) => change({ ...next, projects: config.projects }))}
      <details>
        <summary className="cursor-pointer">{t('opm.settings.advanced')}</summary>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          {fields(initial.restartRequiredKeys, config, initial.defaults, 'global', (next) => change({ ...next, projects: config.projects }))}
        </div>
      </details>
    </SettingsSection>
  </div>;
}

export function OpmSettingsPanel({ loadSettings = fetchOpmSettings, saveSettings = saveOpmSettings }: {
  loadSettings?: typeof fetchOpmSettings; saveSettings?: typeof saveOpmSettings;
}) {
  const { t } = useI18n();
  const [settings, setSettings] = React.useState<OpmSettings | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const loadController = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    loadController.current = controller;
    setSettings(null); setError(null);
    void loadSettings(controller.signal).then((value) => {
      if (!controller.signal.aborted) setSettings(value);
    }, (cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [version, loadSettings]);
  React.useEffect(() => {
    const before = subscribeRuntimeEndpointWillChange(() => { loadController.current?.abort(); setSettings(null); setError(null); });
    const after = subscribeRuntimeEndpointChanged(() => setVersion((prior) => prior + 1));
    return () => { before(); after(); };
  }, []);
  const reload = () => setVersion((prior) => prior + 1);
  return <SettingsSection title={t('opm.settings.title')}>
    {settings ? <SettingsEditor key={version} initial={settings} reload={reload} loadSettings={loadSettings} saveSettings={saveSettings} /> : error ? <><p role="alert">{error}</p><Button onClick={reload}>{t('opm.settings.reload')}</Button></> : <p role="status">{t('common.loading')}</p>}
  </SettingsSection>;
}
