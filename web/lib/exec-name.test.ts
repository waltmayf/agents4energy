import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execName, sharedNamePrefix } from './exec-name.ts';

test('short names pass through unchanged', () => {
  const runId = '11111111-1111-1111-1111-111111111111';
  assert.equal(execName('github-owner-repo-42', runId), `github-owner-repo-42-${runId}`);
});

test('a long prefix keeps the full "<prefix>-" intact and shortens the runId suffix instead', () => {
  const runId = '11111111-1111-1111-1111-111111111111';
  // Mirrors the #200 regression case: a long repo/issue combination.
  const prefix = 'github-aws-samples-sample-edge-to-cloud-digital-ops-workshop-123456789';
  const name = execName(prefix, runId);
  assert.ok(name.length <= 80, `expected <=80 chars, got ${name.length}: ${name}`);
  assert.ok(
    name.startsWith(`${prefix}-`),
    `prefix must stay fully intact so cancelPriorRuns' ListExecutions match still works: ${name}`,
  );
});

test('truncated names for the same prefix stay unique across different runIds', () => {
  const prefix = 'github-aws-samples-sample-edge-to-cloud-digital-ops-workshop-123456789';
  const nameA = execName(prefix, '11111111-1111-1111-1111-111111111111');
  const nameB = execName(prefix, '22222222-2222-2222-2222-222222222222');
  assert.notEqual(nameA, nameB);
});

test('the shared prefix produced by sharedNamePrefix matches what execName always starts with', () => {
  const base = 'github-owner-repo-42';
  const runId = '11111111-1111-1111-1111-111111111111';
  assert.ok(execName(base, runId).startsWith(sharedNamePrefix(base)));

  const longBase = 'github-aws-samples-sample-edge-to-cloud-digital-ops-workshop-123456789';
  assert.ok(execName(longBase, runId).startsWith(sharedNamePrefix(longBase)));
});

test('a pathologically long prefix alone (no room for even a hashed suffix) still returns <=80 chars', () => {
  const runId = '11111111-1111-1111-1111-111111111111';
  const hugePrefix = `github-${'x'.repeat(200)}-999999999`;
  const name = execName(hugePrefix, runId);
  assert.ok(name.length <= 80, `expected <=80 chars, got ${name.length}`);
});
