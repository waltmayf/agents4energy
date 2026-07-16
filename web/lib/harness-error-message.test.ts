import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyHarnessError } from './harness-error-message.ts';

test('rewrites a context-overflow cause into an actionable message', () => {
  // Verbatim shape from the #3/#139 failures.
  const cause =
    'An error occurred (ValidationException) when calling the ConverseStream operation: ' +
    'Input length (1109035) exceeds model\'s maximum context length (131072).';
  const out = friendlyHarnessError(cause);
  assert.ok(out, 'should recognize the overflow');
  assert.match(out, /context window overflowed/);
  assert.match(out, /1,109,035/); // input length, localized
  assert.match(out, /131,072/); // limit, localized
  assert.match(out, /pnpm lint|too much output/);
  assert.doesNotMatch(out, /ValidationException|ConverseStream/); // raw exception hidden
});

test('handles the curly-apostrophe variant', () => {
  const out = friendlyHarnessError("Input length (900000) exceeds model’s maximum context length (131072).");
  assert.ok(out);
  assert.match(out, /context window overflowed/);
});

test('returns null for an unrecognized cause (caller falls back to raw)', () => {
  assert.equal(friendlyHarnessError('Some other transient Bedrock error'), null);
  assert.equal(friendlyHarnessError(''), null);
  assert.equal(friendlyHarnessError(undefined), null);
});
