import React from 'react';
import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { flushDeferredStorage, getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useRememberedProjectSessions } from './useRememberedProjectSessions';

const key = 'oc.sessions.activeSessionByProject';
const storage = getDeferredSafeStorage();
let remembered: ReturnType<typeof useRememberedProjectSessions>;

function Probe() {
  remembered = useRememberedProjectSessions();
  return null;
}

afterEach(() => {
  storage.removeItem(key);
  flushDeferredStorage();
});

test('restores valid project selections and discards only invalid entries', () => {
  storage.setItem(key, JSON.stringify({ first: 'ses_first', empty: '', invalid: 42, second: 'ses_second' }));
  renderToStaticMarkup(<Probe />);
  expect([...remembered.initialActiveSessionByProject]).toEqual([
    ['first', 'ses_first'],
    ['second', 'ses_second'],
  ]);
});

test('malformed storage starts empty and a new selection survives a remount', () => {
  storage.setItem(key, '{broken');
  renderToStaticMarkup(<Probe />);
  expect(remembered.initialActiveSessionByProject.size).toBe(0);
  remembered.persistActiveSessionByProject(new Map([['project', 'ses_next']]));
  flushDeferredStorage();
  renderToStaticMarkup(<Probe />);
  expect([...remembered.initialActiveSessionByProject]).toEqual([['project', 'ses_next']]);
});
