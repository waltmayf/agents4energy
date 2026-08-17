// Unit test for detectMonitorRequest (issue #261, extended by #377).
//
// Run: node --test agent/default/app/ClaudeCode/detect-monitor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMonitorRequest } from './detect-monitor.js';

test('a normal completion has no monitor block', () => {
  const resultText = 'Implemented the feature and opened https://github.com/org/repo/pull/42.';
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('a valid condition-poll block is detected with fields passed through', () => {
  const resultText = [
    'The deploy is running. I will check back periodically.',
    '```monitor',
    JSON.stringify({
      intervalSeconds: 120,
      maxIterations: 20,
      checkCommand: "gh run list --repo org/x --branch main --limit 1 --json status --jq '.[0].status' | grep -q completed",
      followUpPrompt: 'The deploy finished — verify it succeeded and comment the result.',
    }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: {
      kind: 'condition',
      intervalSeconds: 120,
      maxIterations: 20,
      checkCommand: "gh run list --repo org/x --branch main --limit 1 --json status --jq '.[0].status' | grep -q completed",
      followUpPrompt: 'The deploy finished — verify it succeeded and comment the result.',
    },
  });
});

test('condition-poll intervalSeconds is no longer clamped to 900 — a multi-hour interval passes through', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({
      intervalSeconds: 10800, // 3h
      maxIterations: 999,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: {
      kind: 'condition',
      intervalSeconds: 10800,
      maxIterations: 120, // maxIterations clamp ceiling (issue #425: 40 → 120)
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    },
  });
});

test('maxIterations up to the raised ceiling (120) passes through unclamped', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({
      intervalSeconds: 900,
      maxIterations: 120,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    }),
    '```',
  ].join('\n');
  const { spec } = detectMonitorRequest(resultText);
  assert.equal(spec.maxIterations, 120);
});

test('intervalSeconds below the minimum is still clamped up', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({
      intervalSeconds: 1,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    }),
    '```',
  ].join('\n');
  const { spec } = detectMonitorRequest(resultText);
  assert.equal(spec.intervalSeconds, 30);
});

test('an enormous intervalSeconds (near the SFN Wait max) passes through unclamped', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({
      intervalSeconds: 99999999,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    }),
    '```',
  ].join('\n');
  const { spec } = detectMonitorRequest(resultText);
  assert.equal(spec.intervalSeconds, 99999999);
});

test('missing intervalSeconds/maxIterations default to sane values', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ checkCommand: 'exit 0', followUpPrompt: 'Follow up.' }),
    '```',
  ].join('\n');
  const { monitor, spec } = detectMonitorRequest(resultText);
  assert.equal(monitor, true);
  assert.equal(spec.intervalSeconds, 60);
  assert.equal(spec.maxIterations, 10);
});

test('a block missing checkCommand and waitSeconds is a timed wait, defaulting waitSeconds', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ followUpPrompt: 'Follow up.' }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: { kind: 'timed', waitSeconds: 60, followUpPrompt: 'Follow up.' },
  });
});

test('a timed wait with an explicit waitSeconds is detected and kind is tagged "timed"', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ waitSeconds: 10800, followUpPrompt: 'Workers should be done by now — check in.' }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: { kind: 'timed', waitSeconds: 10800, followUpPrompt: 'Workers should be done by now — check in.' },
  });
});

test('a timed wait can request a wait near the SFN Wait max (99,999,999s)', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ waitSeconds: 99999999, followUpPrompt: 'Check in eventually.' }),
    '```',
  ].join('\n');
  const { spec } = detectMonitorRequest(resultText);
  assert.equal(spec.waitSeconds, 99999999);
});

test('a timed wait falls back to intervalSeconds when waitSeconds is absent', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ intervalSeconds: 7200, followUpPrompt: 'Check in.' }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: { kind: 'timed', waitSeconds: 7200, followUpPrompt: 'Check in.' },
  });
});

test('a block missing followUpPrompt is malformed — falls through', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ checkCommand: 'exit 0' }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('a timed-wait block missing followUpPrompt is malformed — falls through', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ waitSeconds: 60 }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('malformed JSON inside the block falls through', () => {
  const resultText = ['```monitor', '{ this is not valid json', '```'].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('empty or non-string input has no monitor block', () => {
  assert.deepEqual(detectMonitorRequest(''), { monitor: false });
  assert.deepEqual(detectMonitorRequest(null), { monitor: false });
  assert.deepEqual(detectMonitorRequest(undefined), { monitor: false });
});
