import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkForSmoothScroll } from './smooth-scroll-chunk.ts';

// Issue #268: the buffered ClaudeCode reply is replayed as several incremental
// deltas so CopilotChat's stick-to-bottom stays pinned. These tests lock in the
// two invariants the auto-scroll fix depends on.

test('short replies pass through as a single chunk (no perceptible delay)', () => {
  const text = 'ok';
  assert.deepEqual(chunkForSmoothScroll(text), [text]);
});

test('a reply at the min-size boundary is not split', () => {
  const text = 'x'.repeat(40);
  assert.deepEqual(chunkForSmoothScroll(text), [text]);
});

test('a long reply is split into multiple chunks, capped at the target count', () => {
  const text = 'y'.repeat(5000);
  const chunks = chunkForSmoothScroll(text);
  assert.ok(chunks.length > 1, 'expected more than one chunk');
  assert.ok(chunks.length <= 24, `expected <=24 chunks, got ${chunks.length}`);
});

test('concatenating chunks always reproduces the original text exactly', () => {
  for (const text of ['', 'a', 'short', 'z'.repeat(41), 'q'.repeat(1234), '💡 unicode ✅ '.repeat(300)]) {
    assert.equal(chunkForSmoothScroll(text).join(''), text);
  }
});

test('empty string yields a single (empty) chunk, never an empty array', () => {
  assert.deepEqual(chunkForSmoothScroll(''), ['']);
});
