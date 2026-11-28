import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('a tree row toggles its reviewed mark without opening the file', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
        Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, DocumentFragment: dom.DocumentFragment,
        Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, FocusEvent: dom.FocusEvent,
        MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, customElements: dom.customElements,
        getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
        cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { FileTree } = await import('./DiffFileNavigation');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const toggled: string[] = [];
    try {
        await act(async () => root.render(
            <I18nProvider>
                <FileTree
                    changedFiles={[
                        { path: 'src/a.ts', index: ' ', working_dir: 'M', insertions: 1, deletions: 0, isNew: false },
                        { path: 'src/b.ts', index: ' ', working_dir: 'M', insertions: 2, deletions: 1, isNew: false },
                    ]}
                    selectedFile={null}
                    onSelectFile={(path) => selected.push(path)}
                    reviewedPaths={new Set(['src/b.ts'])}
                    onToggleReviewed={(path) => toggled.push(path)}
                />
            </I18nProvider>,
        ));
        const mark = container.querySelector<HTMLButtonElement>('button[aria-label="Mark as reviewed"]');
        const unmark = container.querySelector<HTMLButtonElement>('button[aria-label="Unmark as reviewed"]');
        expect(mark?.getAttribute('aria-pressed')).toBe('false');
        expect(unmark?.getAttribute('aria-pressed')).toBe('true');
        expect(mark?.closest('button[title="src/a.ts"]')).toBeNull();

        await act(async () => mark?.click());
        await act(async () => unmark?.click());
        expect(toggled).toEqual(['src/a.ts', 'src/b.ts']);
        expect(selected).toEqual([]);

        await act(async () => container.querySelector<HTMLButtonElement>('button[title="src/a.ts"]')?.click());
        expect(selected).toEqual(['src/a.ts']);
        expect(toggled).toHaveLength(2);
    } finally {
        await act(async () => root.unmount());
        await dom.happyDOM.abort();
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
}, 30_000);
