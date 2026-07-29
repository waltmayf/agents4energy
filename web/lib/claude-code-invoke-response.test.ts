import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvokeResponseText } from './claude-code-invoke-response.ts';

test('parses the success shape from the synchronous invoke path', () => {
  assert.equal(parseInvokeResponseText(JSON.stringify({ result: 'done', repo: null, issueNumber: null })), 'done');
});

test('parses the error shape from a failed invoke', () => {
  assert.equal(parseInvokeResponseText(JSON.stringify({ error: 'boom' })), 'boom');
});

test('falls back to the raw body when it is not JSON', () => {
  assert.equal(parseInvokeResponseText('plain text response'), 'plain text response');
});

test('falls back to the raw body when JSON has neither result nor error', () => {
  const raw = JSON.stringify({ started: true });
  assert.equal(parseInvokeResponseText(raw), raw);
});
