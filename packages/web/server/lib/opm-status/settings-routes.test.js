import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import express from 'express';
import { registerOpmStatusRoutes } from './routes.js';

test('settings proxy preserves authoritative revisions, confirmations, and rejection status', async () => {
  const requests = [];
  let status = 200;
  let payload = { revision: 'one', config: { projects: [] } };
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = express();
  const registration = registerOpmStatusRoutes(app, {
    config: { controlUrl: `http://127.0.0.1:${upstream.address().port}` },
    poller: { poll: async () => {}, current: () => ({ available: false }) },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/opm/settings`;
  try {
    const view = await fetch(url);
    expect(view.headers.get('cache-control')).toBe('no-store');
    expect(await view.json()).toEqual(payload);
    expect(requests[0]).toEqual({ path: '/settings', method: 'GET', body: '' });
    for (const rejection of [403, 409, 422]) {
      status = rejection;
      payload = rejection === 409
        ? { applied: false, confirmationRequired: ['ownerIdentity'], confirmation: 'digest' }
        : { error: 'rejected by OPM' };
      const request = { revision: 'one', config: { projects: [] }, confirmation: 'digest' };
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      expect(response.status).toBe(rejection);
      expect(await response.json()).toEqual(payload);
      expect(JSON.parse(requests.at(-1).body)).toEqual(request);
    }
  } finally {
    registration.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
