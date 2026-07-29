import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwaitingInputMarker } from './awaiting-input.ts';

test('recognizes a marker with an extracted question', () => {
  assert.equal(
    parseAwaitingInputMarker('[awaiting_input] Run ended waiting for user input: Which branch should I target?'),
    'Which branch should I target?',
  );
});

test('recognizes a marker with no question (empty string, not null)', () => {
  assert.equal(
    parseAwaitingInputMarker('[awaiting_input] Run ended waiting for user input.'),
    '',
  );
});

test('returns null for a normal assistant message', () => {
  assert.equal(parseAwaitingInputMarker('Here is the PR you asked for.'), null);
});

test('returns null for unrelated text that merely contains a question mark', () => {
  assert.equal(parseAwaitingInputMarker('Should we ship this?'), null);
});

test('tolerates surrounding whitespace', () => {
  assert.equal(
    parseAwaitingInputMarker('\n  [awaiting_input] Run ended waiting for user input: Pick one?  \n'),
    'Pick one?',
  );
});
