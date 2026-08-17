// Unit test for detectAwaitingInput (issue #185, increment 1).
//
// Run: node --test agent/default/app/ClaudeCode/detect-awaiting-input.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAwaitingInput } from './detect-awaiting-input.js';

test('a normal completion is not awaiting input', () => {
  const resultText = 'Implemented the feature and opened https://github.com/org/repo/pull/42.';
  assert.deepEqual(detectAwaitingInput(resultText), { awaiting: false });
});

test('an ask-for-input final message is detected, with the question extracted', () => {
  const resultText = [
    'I found two ways to fix this:',
    '1. Widen the column type to bigint',
    '2. Add a second shard key',
    'Which approach would you like me to take?',
  ].join('\n');
  assert.deepEqual(detectAwaitingInput(resultText), {
    awaiting: true,
    question: 'Which approach would you like me to take?',
  });
});

test('empty or non-string input is not awaiting input', () => {
  assert.deepEqual(detectAwaitingInput(''), { awaiting: false });
  assert.deepEqual(detectAwaitingInput(null), { awaiting: false });
  assert.deepEqual(detectAwaitingInput(undefined), { awaiting: false });
});
