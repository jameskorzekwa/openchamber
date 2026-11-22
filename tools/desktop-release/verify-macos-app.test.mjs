import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { verifySignedApp, verifyBundledServer } from './verify-macos-app.mjs';

const fingerprint = 'AB'.repeat(32);
const entitlements = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
].map((key) => `<key>${key}</key>`).join('');

function signatureCommands(actualFingerprint = fingerprint) {
  let certificatePrefix;
  const calls = [];
  return {
    calls,
    get certificatePrefix() { return certificatePrefix; },
    runCommand(command, args) {
      calls.push([command, args]);
      if (command === 'codesign' && args[0] === '--verify') {
        assert.deepEqual(args, ['--verify', '--deep', '--strict', '--verbose=2', '/fixture/OpenChamber.app']);
        return { stdout: '', stderr: '' };
      }
      if (command === 'codesign' && args[0] === '-dvvv') return { stdout: '', stderr: 'flags=0x10000(runtime)' };
      if (command === 'codesign' && args[0] === '--display') {
        assert.equal(args.length, 3);
        assert.equal(args[2], '/fixture/OpenChamber.app');
        assert.ok(args[1].startsWith('--extract-certificates='));
        certificatePrefix = args[1].slice('--extract-certificates='.length);
        assert.ok(existsSync(dirname(certificatePrefix)));
        return { stdout: '', stderr: '' };
      }
      if (command === 'openssl') {
        assert.deepEqual(args, ['x509', '-inform', 'DER', '-in', `${certificatePrefix}0`, '-noout', '-fingerprint', '-sha256']);
        return { stdout: `sha256 Fingerprint=${actualFingerprint}`, stderr: '' };
      }
      if (command === 'codesign' && args[0] === '-d') return { stdout: entitlements, stderr: '' };
      throw new Error(`Unexpected external command: ${command}`);
    },
  };
}

test('signed-app verification extracts the certificate with codesign and checks its pinned fingerprint', () => {
  const fixture = signatureCommands();
  verifySignedApp({ appPath: '/fixture/OpenChamber.app', certificateSha256: fingerprint, runCommand: fixture.runCommand });
  assert.ok(fixture.certificatePrefix);
  assert.equal(existsSync(dirname(fixture.certificatePrefix)), false);
});

test('a wrong signing identity fails and still removes the extracted certificate directory', () => {
  const fixture = signatureCommands('CD'.repeat(32));
  assert.throws(() => verifySignedApp({
    appPath: '/fixture/OpenChamber.app', certificateSha256: fingerprint, runCommand: fixture.runCommand,
  }), /differs from the pinned identity/);
  assert.equal(existsSync(dirname(fixture.certificatePrefix)), false);
});

test('server verification checks the packaged payload using the app executable', () => {
  const calls = [];
  const verifyServer = (directory, options) => {
    calls.push([directory, options]);
    return { version: options.version, ran: Boolean(options.runtime) };
  };
  assert.deepEqual(verifyBundledServer({
    resources: '/fixture/Resources', executable: '/fixture/MacOS/OpenChamber',
    opencodeVersion: '2.3.0', verifyServer,
  }), { version: '2.3.0', ran: true });
  assert.deepEqual(calls, [['/fixture/Resources/opencode-server', {
    platform: 'darwin', arch: 'arm64', version: '2.3.0', runtime: '/fixture/MacOS/OpenChamber',
  }]]);
});

test('trusted signing verification checks the payload without executing candidate code', () => {
  let checked = false;
  verifyBundledServer({
    resources: '/fixture/Resources', executable: '/fixture/MacOS/OpenChamber',
    opencodeVersion: '2.3.0', skipCliExecution: true,
    verifyServer(directory, options) {
      checked = true;
      assert.equal(directory, '/fixture/Resources/opencode-server');
      assert.equal(options.runtime, undefined);
      assert.equal(options.version, '2.3.0');
    },
  });
  assert.equal(checked, true);
});
