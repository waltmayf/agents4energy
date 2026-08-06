// Unit test for detectMonitorRequest (issue #261).
//
// Run: node --test agent/default/app/ClaudeCode/detect-monitor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMonitorRequest } from './detect-monitor.js';

test('a normal completion has no monitor block', () => {
  const resultText = 'Implemented the feature and opened https://github.com/org/repo/pull/42.';
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('a valid monitor block is detected with fields passed through', () => {
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
      intervalSeconds: 120,
      maxIterations: 20,
      checkCommand: "gh run list --repo org/x --branch main --limit 1 --json status --jq '.[0].status' | grep -q completed",
      followUpPrompt: 'The deploy finished — verify it succeeded and comment the result.',
    },
  });
});

test('intervalSeconds and maxIterations are clamped into range', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({
      intervalSeconds: 1,
      maxIterations: 999,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), {
    monitor: true,
    spec: {
      intervalSeconds: 30,
      maxIterations: 40,
      checkCommand: 'exit 0',
      followUpPrompt: 'Follow up.',
    },
  });
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

test('a block missing checkCommand is malformed — falls through', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ followUpPrompt: 'Follow up.' }),
    '```',
  ].join('\n');
  assert.deepEqual(detectMonitorRequest(resultText), { monitor: false });
});

test('a block missing followUpPrompt is malformed — falls through', () => {
  const resultText = [
    '```monitor',
    JSON.stringify({ checkCommand: 'exit 0' }),
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
