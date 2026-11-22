import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SessionDeleteSummary } from './SessionDeleteSummary';

const session = (id: string): Session => ({
    id,
    title: `Conversation ${id}`,
    projectID: 'project',
    directory: '/home/james/project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
});

test('deletion preview lists five sessions and reports the remaining count', () => {
    const browser = new Window();
    browser.document.body.innerHTML = renderToStaticMarkup(
        <I18nProvider>
            <SessionDeleteSummary
                sessions={Array.from({ length: 7 }, (_, index) => session(String(index)))}
                isWorktreeDelete={false}
                targetWorktree={null}
                homeDirectory="/home/james"
                hasDirtyWorktrees={false}
            />
        </I18nProvider>,
    );
    const items = Array.from(browser.document.querySelectorAll('li'));
    expect(items).toHaveLength(6);
    expect(items.slice(0, 5).map((item) => item.querySelector('[dir="auto"]')?.textContent)).toEqual([
        'Conversation 0', 'Conversation 1', 'Conversation 2', 'Conversation 3', 'Conversation 4',
    ]);
    expect(items[5].textContent).toContain('2');
    expect(browser.document.body.textContent).not.toContain('Conversation 5');
    browser.happyDOM.abort();
});

test('worktree preview names its target and only warns about confirmed dirty worktrees', () => {
    const browser = new Window();
    const render = (dirty: boolean) => renderToStaticMarkup(
        <I18nProvider>
            <SessionDeleteSummary
                sessions={[]}
                isWorktreeDelete
                targetWorktree={{
                    path: '/home/james/project/worktree',
                    projectDirectory: '/home/james/project',
                    branch: 'feature',
                    label: 'Feature checkout',
                }}
                homeDirectory="/home/james"
                hasDirtyWorktrees={dirty}
            />
        </I18nProvider>,
    );
    browser.document.body.innerHTML = render(true);
    expect(browser.document.body.textContent).toContain('Feature checkout');
    expect(browser.document.body.textContent).toContain('~/project/worktree');
    expect(browser.document.querySelector('.text-status-warning')?.textContent).toBeTruthy();
    expect(browser.document.querySelector('ul')).toBeNull();
    browser.document.body.innerHTML = render(false);
    expect(browser.document.querySelector('.text-status-warning')).toBeNull();
    browser.happyDOM.abort();
});
