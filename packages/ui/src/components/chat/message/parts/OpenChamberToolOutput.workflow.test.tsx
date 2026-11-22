import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { JsonValue, ToolPart } from '@/lib/opencode/model';
import { OpenChamberToolOutput } from './OpenChamberToolOutput';

const part: ToolPart = {
    id: 'part_workflow', sessionID: 'ses_workflow', messageID: 'msg_workflow',
    type: 'tool', callID: 'call_workflow', tool: 'openchamber',
    state: { status: 'completed', input: {}, output: '', time: { start: 0, end: 1 } },
};

const render = (action: string, data: JsonValue) => {
    const container = new Window().document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        <I18nProvider>
            <OpenChamberToolOutput
                envelope={{ ok: true, action, data, errorMessage: undefined }}
                part={part} input={{}} directory="/repo" isMobile
                rawToggle={<button>Raw result</button>}
            />
        </I18nProvider>,
    );
    return container;
};

test('workflow checks retain phase ordering and the raw result action', () => {
    const view = render('workflow.check', { name: 'Release', description: 'Ship safely', phases: ['Build', 'Review'] });
    expect(view.textContent).toContain('Release');
    expect(view.textContent).toContain('Ship safely');
    expect(Array.from(view.querySelectorAll('li'), (row) => row.textContent)).toEqual(['1. Build', '2. Review']);
    expect(view.querySelector('button')?.textContent).toBe('Raw result');
    expect(render('workflow.check', { phases: [] }).textContent).toBe('');
});

test('workflow results distinguish plain text, structured answers and agent failures', () => {
    const plain = render('workflow.result', { runId: 'run_one', state: 'completed', result: 'Ready to ship' });
    expect(plain.textContent).toContain('Ready to ship');
    expect(plain.textContent).not.toContain('"Ready to ship"');
    const structured = render('workflow.result', { runId: 'run_one', state: 'completed', result: { count: 2 } });
    expect(structured.textContent).toContain('{\n  "count": 2\n}');
    const failed = render('workflow.result', { runId: 'run_one', agent: { label: 'Review agent', state: 'failed', error: 'Provider offline' } });
    expect(failed.textContent).toContain('Review agent');
    expect(failed.textContent).toContain('Provider offline');
    expect(failed.textContent).toContain('Raw result');
    expect(render('workflow.result', { result: 'unidentified' }).textContent).toBe('');
});

test('workflow lists preserve saved definitions, run states and definition errors', () => {
    const view = render('workflow.list', {
        workflows: [{ name: 'Release', description: 'Ship safely' }, { name: 'Broken', error: 'Invalid phase' }],
        runs: [{ runId: 'run_one', name: 'Active release', state: 'running' }],
    });
    expect(Array.from(view.querySelectorAll('li'), (row) => row.textContent)).toEqual([
        'ReleaseShip safely', 'BrokenInvalid phase', 'Active releaseRunning',
    ]);
    expect(view.textContent).toContain('Raw result');
});

test('workflow save and resume retain the path and reused-agent count', () => {
    const saved = render('workflow.save', { name: 'Release', path: '/repo/release.yaml' });
    expect(saved.textContent).toContain('Release');
    expect(saved.textContent).toContain('/repo/release.yaml');
    expect(render('workflow.resume', { runId: 'run_one', state: 'running', reused: 2 }).textContent).toContain('2');
    expect(render('workflow.stop', { runId: 'run_one', state: 'stopped' }).textContent).toBe('Raw result');
});
