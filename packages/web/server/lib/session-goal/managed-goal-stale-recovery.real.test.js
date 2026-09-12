import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createManagedGoalStaleRecovery } from './managed-goal-stale-recovery.js';

const executable = async () => {
  const names = [process.env.OPENCODE_BINARY, ...String(process.env.PATH || '')
    .split(path.delimiter)
    .map((directory) => path.join(directory, 'opencode'))]
    .filter(Boolean);
  for (const name of names) {
    try {
      await access(name);
      return name;
    } catch {}
  }
  return '';
};

const binary = await executable();

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const stopServer = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});

const waitFor = async (check, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for isolated OpenCode fixture');
};

const openAiChunk = (response, body) => {
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl_fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'recovery',
    choices: [{ index: 0, ...body }],
  })}\n\n`);
};

const finishText = (response, text) => {
  openAiChunk(response, { delta: { role: 'assistant', content: text }, finish_reason: null });
  openAiChunk(response, { delta: {}, finish_reason: 'stop' });
  response.end('data: [DONE]\n\n');
};

const createModelServer = async () => {
  let requests = 0;
  let childStarted = false;
  const hanging = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'recovery', object: 'model' }] }));
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    requests += 1;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (requests === 1) {
      openAiChunk(response, {
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_restart_fixture',
            type: 'function',
            function: {
              name: 'task',
              arguments: JSON.stringify({
                description: 'Hang across restart',
                prompt: 'Wait for the fixture.',
                subagent_type: 'general',
              }),
            },
          }],
        },
        finish_reason: null,
      });
      openAiChunk(response, { delta: {}, finish_reason: 'tool_calls' });
      response.end('data: [DONE]\n\n');
      return;
    }
    if (requests === 2) {
      childStarted = true;
      hanging.add(response);
      response.on('close', () => hanging.delete(response));
      return;
    }
    finishText(response, 'Recovered after restart.');
  });
  const port = await listen(server);
  return {
    port,
    requests: () => requests,
    childStarted: () => childStarted,
    close: async () => {
      for (const response of hanging) response.destroy();
      await stopServer(server);
    },
  };
};

const reservePort = async () => {
  const server = http.createServer();
  const port = await listen(server);
  await stopServer(server);
  return port;
};

const startOpenCode = async ({ directory, dataDirectory, modelPort, port }) => {
  const config = {
    model: 'fixture/recovery',
    permission: { '*': 'allow' },
    provider: {
      fixture: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Restart recovery fixture',
        options: { apiKey: 'fixture', baseURL: `http://127.0.0.1:${modelPort}/v1` },
        models: { recovery: { name: 'Recovery fixture' } },
      },
    },
  };
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_DATA_HOME: dataDirectory,
      XDG_CONFIG_HOME: path.join(dataDirectory, 'config'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`isolated OpenCode exited early: ${output}`);
    try {
      return (await fetch(`http://127.0.0.1:${port}/global/health`)).ok;
    } catch {
      return false;
    }
  });
  return {
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await waitFor(() => child.exitCode !== null, 5_000).catch(() => {
        child.kill('SIGKILL');
      });
    },
  };
};

test.runIf(Boolean(binary))('recovers a real foreground task orphaned by an OpenCode restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openchamber-real-stale-recovery-'));
  const workspace = path.join(root, 'workspace');
  const dataDirectory = path.join(root, 'xdg');
  const recoveryDirectory = path.join(root, 'controller');
  await Promise.all([mkdir(workspace), mkdir(dataDirectory), mkdir(recoveryDirectory)]);
  const git = spawn('git', ['init', '--quiet'], { cwd: workspace });
  await new Promise((resolve, reject) => {
    git.once('error', reject);
    git.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)));
  });
  const model = await createModelServer();
  const port = await reservePort();
  let opencode;
  try {
    opencode = await startOpenCode({ directory: workspace, dataDirectory, modelPort: model.port, port });
    const base = `http://127.0.0.1:${port}`;
    const request = async (pathname, options = {}) => {
      const url = new URL(pathname, base);
      url.searchParams.set('directory', workspace);
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : {},
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} returned ${response.status}: ${await response.text()}`);
      if (response.status === 204) return null;
      return response.json();
    };

    const session = await request('/session', { method: 'POST', body: { title: 'restart fixture' } });
    const goal = {
      id: 'goal_real_restart',
      objective: 'Recover the restart fixture.',
      managedWorktree: true,
      status: 'active',
      statusReason: '',
      turnsUsed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await request(`/session/${session.id}`, { method: 'PATCH', body: { metadata: { openchamber: { goal } } } });
    await request(`/session/${session.id}/prompt_async`, {
      method: 'POST',
      body: {
        model: { providerID: 'fixture', modelID: 'recovery' },
        agent: 'build',
        parts: [{ type: 'text', text: 'Start the foreground restart fixture.' }],
      },
    });
    await waitFor(() => model.childStarted());
    const childrenBefore = await waitFor(async () => {
      const children = await request(`/session/${session.id}/children`);
      return children.length === 1 ? children : null;
    });
    const childId = childrenBefore[0].id;

    await opencode.stop();
    opencode = await startOpenCode({ directory: workspace, dataDirectory, modelPort: model.port, port });

    const warnings = [];
    const recovery = createManagedGoalStaleRecovery({
      openCodeFetch: (pathname, options = {}) => request(pathname, options),
      buildRecoveryPrompt: async () => 'Continue after the isolated restart.',
      staleMs: 0,
      maxAbortAttempts: 1,
      initialBackoffMs: 10,
      maxBackoffMs: 10,
      deliveryBackoffMs: 10,
      stateDirectory: recoveryDirectory,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      logger: { warn: (...args) => warnings.push(args) },
    });
    await recovery.discoverNow();
    await recovery.scanNow();

    const rootMessages = await waitFor(async () => {
      const current = await request(`/session/${session.id}/message`);
      return current.some((message) => message?.parts?.some((part) => part?.text === 'Recovered after restart.'))
        ? current
        : null;
    });
    const childMessages = await request(`/session/${childId}/message`);
    await recovery.scanNow();
    const recoveryUsers = rootMessages.filter((message) => (
      message.info?.role === 'user'
      && message.parts?.some((part) => part?.text === 'Continue after the isolated restart.')
    ));
    const task = rootMessages
      .flatMap((message) => message.parts || [])
      .find((part) => part?.tool === 'task' && part?.state?.metadata?.sessionId === childId);

    assert.equal(recoveryUsers.length, 1);
    assert.equal(task?.state?.status, 'error');
    assert.equal(task?.state?.metadata?.interrupted, true);
    assert.match(task?.state?.error || '', /outcome is unknown/);
    assert.equal(childMessages.at(-1)?.info?.time?.completed, undefined);
    assert.equal(childMessages.at(-1)?.info?.error, undefined);
    assert.ok(warnings.some((warning) => warning[0].includes('verified continuation')));

    recovery.stop();
    const restartedRecovery = createManagedGoalStaleRecovery({
      openCodeFetch: (pathname, options = {}) => request(pathname, options),
      staleMs: 0,
      maxAbortAttempts: 1,
      stateDirectory: recoveryDirectory,
      sleep: async () => {},
      logger: { warn: () => {} },
    });
    await restartedRecovery.discoverNow();
    await restartedRecovery.scanNow();
    const afterRestart = await request(`/session/${session.id}/message`);
    assert.equal(afterRestart.filter((message) => message.info?.id === recoveryUsers[0].info.id).length, 1);
    assert.equal(model.requests(), 3);
    restartedRecovery.stop();
  } finally {
    await opencode?.stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
