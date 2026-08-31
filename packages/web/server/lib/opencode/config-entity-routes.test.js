import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerConfigEntityRoutes } from './config-entity-routes.js';

const guardError = () => Object.assign(
  new Error('OpenChamber refuses to modify project configuration in the primary worktree'),
  { code: 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY', statusCode: 409 },
);

const createApp = () => {
  const app = express();
  app.use(express.json());
  const rejectMutation = vi.fn(() => {
    throw guardError();
  });
  registerConfigEntityRoutes(app, {
    resolveProjectDirectory: async () => ({ directory: '/primary' }),
    resolveOptionalProjectDirectory: async () => ({ directory: '/primary' }),
    getAgentSources: vi.fn(),
    getAgentConfig: vi.fn(),
    createAgent: rejectMutation,
    updateAgent: rejectMutation,
    deleteAgent: rejectMutation,
  });
  return app;
};

describe('agent config route mutation guards', () => {
  it.each([
    ['post', '/api/config/agents/guarded', { scope: 'project', prompt: 'prompt' }],
    ['patch', '/api/config/agents/guarded', { prompt: 'prompt' }],
    ['delete', '/api/config/agents/guarded', { scope: 'project' }],
  ])('returns HTTP 409 and the guard code for %s', async (method, url, body) => {
    const response = await request(createApp())[method](url).send(body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'OPENCHAMBER_PRIMARY_WORKTREE_READ_ONLY',
    });
  });
});
