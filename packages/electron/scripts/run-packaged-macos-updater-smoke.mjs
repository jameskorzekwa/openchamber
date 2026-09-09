#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFixtureServer, stageMacUpdaterFixture } from './updater-e2e-fixture.mjs';

const parseArguments = (tokens) => {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key || '<end>'}`);
    options[key.slice(2)] = value;
  }
  return options;
};

const required = (options, name) => options[name] || (() => { throw new Error(`Missing --${name}`); })();

const closeServer = (server) => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

const runChild = ({ executable, environment, isolationRoot, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(executable, [], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let timedOut = false;
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  }, timeoutMs);
  child.once('error', (error) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    reject(error);
  });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (timedOut) {
      reject(new Error('Packaged updater smoke process timed out'));
      return;
    }
    if (code !== 0) {
      const sanitized = output.replaceAll(isolationRoot, '<isolated>').trim();
      reject(new Error(`Packaged updater smoke exited with ${signal || code}\n${sanitized}`.trim()));
      return;
    }
    resolve();
  });
});

export const runMacUpdaterSmokeHarness = async ({
  appPath,
  nextZip,
  nextVersion,
  sourceRevision,
  outputPath,
  timeoutMs = 180_000,
}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-macos-updater-smoke-'));
  const feedDirectory = path.join(root, 'feed');
  const isolationRoot = path.join(root, 'runtime');
  const appEvidencePath = path.join(root, 'app-evidence.json');
  const executable = path.join(path.resolve(appPath), 'Contents', 'MacOS', 'OpenChamber');
  if (!fs.statSync(executable).isFile()) throw new Error('Packaged updater smoke app executable is missing');

  const fixture = stageMacUpdaterFixture({ nextZip, version: nextVersion, directory: feedDirectory });
  const { requests, server, url } = await createFixtureServer({ directory: feedDirectory });
  try {
    fs.mkdirSync(path.join(isolationRoot, 'home'), { recursive: true });
    fs.mkdirSync(path.join(isolationRoot, 'tmp'), { recursive: true });
    await runChild({
      executable,
      isolationRoot,
      timeoutMs,
      environment: {
        ...process.env,
        HOME: path.join(isolationRoot, 'home'),
        TMPDIR: path.join(isolationRoot, 'tmp'),
        OPENCHAMBER_E2E: '1',
        OPENCHAMBER_PACKAGED_UPDATER_SMOKE: '1',
        OPENCHAMBER_UPDATER_E2E_URL: url,
        OPENCHAMBER_UPDATER_SMOKE_ROOT: isolationRoot,
        OPENCHAMBER_UPDATER_SMOKE_EVIDENCE: appEvidencePath,
        OPENCHAMBER_UPDATER_SMOKE_NEXT_VERSION: nextVersion,
        OPENCHAMBER_UPDATER_SMOKE_NEXT_SHA512: fixture.checksum,
      },
    });

    const evidence = JSON.parse(fs.readFileSync(appEvidencePath, 'utf8'));
    const manifestRequest = requests.find((request) => request.method === 'GET' && request.path === '/latest-mac.yml' && request.status === 200);
    const payloadRequest = requests.find((request) => request.method === 'GET'
      && request.path === `/${encodeURIComponent(path.basename(fixture.artifactPath))}`
      && request.status === 200
      && request.bytes === fixture.size);
    if (!manifestRequest) throw new Error('Packaged updater smoke did not request latest-mac.yml');
    if (!payloadRequest) throw new Error('Packaged updater smoke did not complete the fixture payload request');
    if (evidence.downloadedSha512 !== fixture.checksum || evidence.discoveredVersion !== nextVersion) {
      throw new Error('Packaged updater smoke evidence differs from the trusted fixture');
    }
    if (evidence.downloadedBytes !== fixture.size) {
      throw new Error('Packaged updater smoke downloaded payload size differs from the trusted fixture');
    }

    const finalEvidence = {
      ...evidence,
      sourceRevision,
      fixturePayload: path.basename(fixture.artifactPath),
      fixtureBytes: fixture.size,
      manifestDownloaded: true,
      payloadDownloaded: true,
    };
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(finalEvidence, null, 2)}\n`, { mode: 0o600 });
    return finalEvidence;
  } finally {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const evidence = await runMacUpdaterSmokeHarness({
    appPath: required(options, 'app'),
    nextZip: required(options, 'next-zip'),
    nextVersion: required(options, 'next-version'),
    sourceRevision: required(options, 'source-revision'),
    outputPath: required(options, 'output'),
    timeoutMs: Number(options['timeout-ms'] || 180_000),
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
