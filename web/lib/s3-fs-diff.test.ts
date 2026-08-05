import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSearchReplaceBlocks,
  applyDiff,
  DiffFormatError,
  DiffApplyError,
} from './s3-fs-diff.ts';

function block(search: string, replace: string, startLine?: number): string {
  const hint = startLine != null ? `:start_line:${startLine}\n-------\n` : '';
  return `<<<<<<< SEARCH\n${hint}${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

test('parses a single block', () => {
  const blocks = parseSearchReplaceBlocks(block('foo', 'bar'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].search, 'foo');
  assert.equal(blocks[0].replace, 'bar');
  assert.equal(blocks[0].startLineHint, null);
});

test('parses the optional :start_line: hint', () => {
  const blocks = parseSearchReplaceBlocks(block('foo', 'bar', 5));
  assert.equal(blocks[0].startLineHint, 5);
});

test('parses multiple blocks in one diff', () => {
  const diff = `${block('a', 'b')}\n${block('c', 'd')}`;
  const blocks = parseSearchReplaceBlocks(diff);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].search, 'a');
  assert.equal(blocks[1].search, 'c');
});

test('tolerates a stray trailing > after SEARCH', () => {
  const diff = '<<<<<<< SEARCH>\nfoo\n=======\nbar\n>>>>>>> REPLACE';
  const blocks = parseSearchReplaceBlocks(diff);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].search, 'foo');
});

test('throws DiffFormatError on unterminated SEARCH block', () => {
  assert.throws(() => parseSearchReplaceBlocks('<<<<<<< SEARCH\nfoo\n'), DiffFormatError);
});

test('unescapes backslash-escaped marker-like content lines', () => {
  const diff = '<<<<<<< SEARCH\n\\<<<<<<< SEARCH\n=======\nreplaced\n>>>>>>> REPLACE';
  const blocks = parseSearchReplaceBlocks(diff);
  assert.equal(blocks[0].search, '<<<<<<< SEARCH');
});

// -- applyDiff: exact match ---------------------------------------------------

test('applies an exact match replacement', () => {
  const original = 'line1\nline2\nline3\n';
  const { content } = applyDiff(original, block('line2', 'replaced'));
  assert.equal(content, 'line1\nreplaced\nline3\n');
});

test('applies multiple blocks top-to-bottom against the evolving buffer', () => {
  const original = 'a\nb\nc\n';
  const diff = `${block('a', 'A')}\n${block('c', 'C')}`;
  const { content } = applyDiff(original, diff);
  assert.equal(content, 'A\nb\nC\n');
});

test('errors when a SEARCH block matches multiple locations', () => {
  const original = 'dup\nmiddle\ndup\n';
  assert.throws(() => applyDiff(original, block('dup', 'X')), (err: unknown) => {
    assert.ok(err instanceof DiffApplyError);
    assert.match((err as Error).message, /matched 2 locations/);
    return true;
  });
});

test('errors with an actionable message when there is no match', () => {
  const original = 'foo\nbar\n';
  assert.throws(() => applyDiff(original, block('nonexistent content', 'X')), (err: unknown) => {
    assert.ok(err instanceof DiffApplyError);
    assert.match((err as Error).message, /no match found for SEARCH block 1/);
    return true;
  });
});

// -- applyDiff: fuzzy match ----------------------------------------------------

test('fuzzy-matches near-identical content when threshold is lowered', () => {
  // Trailing whitespace difference vs. the SEARCH block's exact text.
  const original = 'function foo() {\n  return 1;   \n}\n';
  const search = 'function foo() {\n  return 1;\n}';
  const { content } = applyDiff(original, block(search, 'function foo() {\n  return 2;\n}'), { fuzzyThreshold: 0.9 });
  assert.equal(content, 'function foo() {\n  return 2;\n}\n');
});

test('fuzzy match respects the :start_line: hint to disambiguate ties', () => {
  // Four identical lines, each an equal-distance near-miss of the search text
  // ("hellp" vs "hello": 1 substitution) — no raw substring match exists, so
  // every window ties at the same fuzzy score. The :start_line: hint should
  // pick the line closest to it (1-indexed line 3 -> 0-indexed line 2).
  const original = 'hello\nhello\nhello\nhello\n';
  const withHint = applyDiff(original, block('hellp', 'REPLACED', 3), { fuzzyThreshold: 0.75 });
  assert.equal(withHint.content.split('\n')[2], 'REPLACED');
});

test('normalizes smart quotes before fuzzy comparison', () => {
  const original = 'echo “hello”\n';
  const search = 'echo "hello"';
  const { content } = applyDiff(original, block(search, 'echo "goodbye"'), { fuzzyThreshold: 0.9 });
  assert.equal(content, 'echo "goodbye"\n');
});

// -- applyDiff: file creation ---------------------------------------------------

test('empty SEARCH block creates a new file', () => {
  const { content, created } = applyDiff(undefined, block('', 'brand new content'));
  assert.equal(content, 'brand new content');
  assert.equal(created, true);
});

test('empty SEARCH block against an existing empty file overwrites it', () => {
  const { content, created } = applyDiff('', block('', 'now has content'));
  assert.equal(content, 'now has content');
  assert.equal(created, false);
});

test('empty SEARCH block against a non-empty existing file errors', () => {
  assert.throws(() => applyDiff('already has stuff', block('', 'new')), DiffApplyError);
});

test('non-empty SEARCH block against a non-existent file errors', () => {
  assert.throws(() => applyDiff(undefined, block('anything', 'new')), DiffApplyError);
});

test('throws DiffFormatError when the diff has no blocks at all', () => {
  assert.throws(() => applyDiff('content', 'not a diff at all'), DiffFormatError);
});
