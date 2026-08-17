// Unit tests for the awaiting-input memory marker (issue #185, increment 2).
//
// Run: node --test agent/default/app/ClaudeCode/memory.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAwaitingInputMarkerBlocks, persistAwaitingInputMarker } from './memory.js';

test('buildAwaitingInputMarkerBlocks includes the question in a single text block', () => {
  const blocks = buildAwaitingInputMarkerBlocks('Which approach would you like me to take?');
  assert.deepEqual(blocks, [
    { text: '[awaiting_input] Run ended waiting for user input: Which approach would you like me to take?' },
  ]);
});

test('buildAwaitingInputMarkerBlocks falls back to a generic marker with no question', () => {
  const blocks = buildAwaitingInputMarkerBlocks(undefined);
  assert.deepEqual(blocks, [{ text: '[awaiting_input] Run ended waiting for user input.' }]);
});

test('persistAwaitingInputMarker sends a Converse-shaped ASSISTANT CreateEvent', async () => {
  const calls = [];
  const fakeClient = { send: async (cmd) => { calls.push(cmd.input); } };
  await persistAwaitingInputMarker(fakeClient, {
    memoryId: 'mem-1',
    sessionId: 'sess-1',
    question: 'Which approach would you like me to take?',
    log: () => {},
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.memoryId, 'mem-1');
  assert.equal(call.sessionId, 'sess-1');
  assert.equal(call.payload[0].conversational.role, 'ASSISTANT');
  const blocks = JSON.parse(call.payload[0].conversational.content.text);
  assert.deepEqual(blocks, [
    { text: '[awaiting_input] Run ended waiting for user input: Which approach would you like me to take?' },
  ]);
});

test('persistAwaitingInputMarker is a no-op without a client (best-effort)', async () => {
  await assert.doesNotReject(persistAwaitingInputMarker(null, {
    memoryId: 'mem-1', sessionId: 'sess-1', question: 'q?', log: () => {},
  }));
});
