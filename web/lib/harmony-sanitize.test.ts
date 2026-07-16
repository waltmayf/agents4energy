import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHarmony, looksLikeHarmony } from './harmony-sanitize.ts';

test('plain natural-language response is returned untouched (aside from trim)', () => {
  const clean = 'I opened PR #42 which fixes the compile error. Let me know if you want changes.';
  assert.equal(sanitizeHarmony(`  ${clean}  `), clean);
  assert.equal(looksLikeHarmony(clean), false);
});

test('strips the exact leaked commentary-channel tool call from issue #62 (#105)', () => {
  // Verbatim from the #105 report.
  const leaked =
    'Now cd repo.</assistant<|channel|>commentary to=functions.shell   <|message|>{"command":"cd agents4energy && pnpm install","timeout": 1000000}';
  const out = sanitizeHarmony(leaked);
  assert.equal(looksLikeHarmony(out), false, `still contains Harmony markup: ${out}`);
  assert.ok(!out.includes('<|'), 'no Harmony tokens remain');
  assert.ok(!out.includes('functions.shell'), 'tool recipient stripped');
  assert.ok(!/command/.test(out) || !out.includes('{'), 'raw tool-call JSON removed');
  assert.ok(out.startsWith('Now cd repo.'), `kept the prose lead-in: ${out}`);
});

test('keeps only the final channel when analysis + final are both present', () => {
  const input =
    '<|channel|>analysis<|message|>The user wants a summary. Let me think step by step about it.' +
    '<|end|><|start|>assistant<|channel|>final<|message|>Done — I fixed the bug and opened PR #7.';
  const out = sanitizeHarmony(input);
  assert.equal(out, 'Done — I fixed the bug and opened PR #7.');
});

test('drops analysis/commentary scaffolding when there is no final channel', () => {
test('removes trailing raw tool-call JSON when no Harmony tokens present', () => {
  const input = 'Now commit.{"command":"cd repo && git commit -m \"test\"","timeout":100000}';
  const out = sanitizeHarmony(input);
  assert.equal(out, 'Now commit.');
});

  const input =
    '<|channel|>analysis<|message|>internal reasoning that should never be shown';
  const out = sanitizeHarmony(input);
  assert.equal(out, '');
});

test('removes stray role tokens without a channel wrapper', () => {
  const input = '<|start|>assistant<|message|>All set!<|end|>';
  assert.equal(sanitizeHarmony(input), 'All set!');
});

test('looksLikeHarmony detects tokens and stray role tags', () => {
  assert.equal(looksLikeHarmony('text <|message|> more'), true);
  assert.equal(looksLikeHarmony('foo </assistant bar'), true);
  assert.equal(looksLikeHarmony('a totally normal sentence.'), false);
});

test('collapses whitespace left behind by removals', () => {
  const input = '<|channel|>final<|message|>Line one.\n\n\n\nLine two.';
  assert.equal(sanitizeHarmony(input), 'Line one.\n\nLine two.');
});

test('empty / falsy input is passed through', () => {
  assert.equal(sanitizeHarmony(''), '');
});
