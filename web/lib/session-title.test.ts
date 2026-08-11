import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSessionTitle,
  isPlaceholderName,
  DEFAULT_SESSION_NAME,
  MAX_TITLE_LENGTH,
} from './session-title.ts';

test('isPlaceholderName treats empty, whitespace, and the default as placeholders', () => {
  assert.equal(isPlaceholderName(''), true);
  assert.equal(isPlaceholderName('   '), true);
  assert.equal(isPlaceholderName(null), true);
  assert.equal(isPlaceholderName(undefined), true);
  assert.equal(isPlaceholderName(DEFAULT_SESSION_NAME), true);
});

test('isPlaceholderName leaves a real (user-renamed) name alone', () => {
  assert.equal(isPlaceholderName('Q3 well analysis'), false);
  assert.equal(isPlaceholderName('New Chat about pumps'), false); // not exactly the placeholder
});

test('deriveSessionTitle returns null for empty / whitespace-only input', () => {
  assert.equal(deriveSessionTitle(''), null);
  assert.equal(deriveSessionTitle('   \n\t '), null);
});

test('deriveSessionTitle collapses internal whitespace and newlines', () => {
  assert.equal(deriveSessionTitle('hello   world\n\nfoo'), 'hello world foo');
});

test('deriveSessionTitle keeps short messages verbatim', () => {
  assert.equal(deriveSessionTitle('What is the well status?'), 'What is the well status?');
});

test('deriveSessionTitle truncates long input on a word boundary with an ellipsis', () => {
  const long =
    'Please summarize the production decline curve analysis for the Permian basin wells over the last decade';
  const out = deriveSessionTitle(long, 40)!;
  assert.ok(out.endsWith('…'), `expected ellipsis, got: ${out}`);
  assert.ok(out.length <= 41, `expected <= 41 chars incl ellipsis, got ${out.length}`);
  assert.ok(!out.slice(0, -1).endsWith(' '), 'should not leave a trailing space before ellipsis');
  // Cut on a word boundary — no partial trailing word.
  assert.ok(long.startsWith(out.slice(0, -1)));
});

test('deriveSessionTitle falls back to a hard cut when the first word is longer than maxLength', () => {
  const oneLongWord = 'x'.repeat(100);
  const out = deriveSessionTitle(oneLongWord, 40)!;
  assert.equal(out, `${'x'.repeat(40)}…`);
});

test('deriveSessionTitle defaults to MAX_TITLE_LENGTH', () => {
  const long = 'word '.repeat(50).trim();
  const out = deriveSessionTitle(long)!;
  assert.ok(out.length <= MAX_TITLE_LENGTH + 1);
});
