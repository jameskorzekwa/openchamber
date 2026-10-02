import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('fork bundle assembly requires both native web builds and fails on missing artifacts', () => {
  const assembly = workflow.jobs['assemble-web-bundle'];
  assert.deepEqual(assembly.needs, ['metadata', 'validate-release', 'validate-release-linux']);
  // With no explicit condition, Actions applies success() to every dependency.
  // Unlike upstream's partial Electron manifests, schema 2 needs both targets.
  assert.equal(assembly.if, undefined);
  assert.notEqual(assembly['continue-on-error'], true);
  for (const name of assembly.needs) {
    assert.notEqual(workflow.jobs[name]['continue-on-error'], true);
  }
  for (const step of assembly.steps) {
    assert.equal(step.if, undefined);
    assert.notEqual(step['continue-on-error'], true);
  }
  const downloads = assembly.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.deepEqual(downloads.map((step) => step.with.name), [
    'channel-release-target-${{ needs.metadata.outputs.release_tag }}-darwin-arm64-abi127',
    'channel-release-target-${{ needs.metadata.outputs.release_tag }}-linux-x64-abi127',
  ]);
  const upload = assembly.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('fork publication rejects every unsuccessful prerequisite and untrusted workflow context', () => {
  const publish = workflow.jobs.publish;
  const prerequisites = ['metadata', 'validate-release', 'validate-release-linux', 'assemble-web-bundle', 'build-desktop'];
  assert.deepEqual(publish.needs, prerequisites);
  assert.equal(publish.environment, 'j2k-release');
  assert.equal(publish.permissions.contents, 'write');

  // Evaluate the actual condition over a result matrix. GitHub permits hyphens
  // in property names, so translate only those accesses for JavaScript.
  const condition = publish.if.replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  const trusted = {
    repository: 'fixture/openchamber',
    workflow_ref: 'fixture/openchamber/.github/workflows/release.yml@refs/heads/j2k/current',
    event_name: 'workflow_run',
    ref: 'refs/heads/j2k/current',
  };
  function eligible(results = {}, context = {}) {
    return runInNewContext(condition, {
      needs: Object.fromEntries(prerequisites.map((name) => [name, { result: results[name] ?? 'success' }])),
      github: { ...trusted, ...context },
      format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
    }, { timeout: 1000 });
  }
  assert.equal(eligible(), true);
  assert.equal(eligible({}, { event_name: 'workflow_dispatch' }), true);
  for (const name of prerequisites) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(eligible({ [name]: result }), false, `${name}: ${result} must block publication`);
    }
  }
  assert.equal(eligible({}, { workflow_ref: 'fixture/openchamber/.github/workflows/release.yml@refs/heads/j2k/v2.1.0' }), false);
  assert.equal(eligible({}, { event_name: 'workflow_dispatch', ref: 'refs/heads/j2k/v2.1.0' }), false);
});
