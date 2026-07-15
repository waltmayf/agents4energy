import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInjectedBlocks } from './split-injected-blocks.ts';

test('plain message with no injected blocks returns no blocks and unchanged remainder', () => {
  const { blocks, remainder } = splitInjectedBlocks('please fix the bug in handler.ts');
  assert.deepEqual(blocks, []);
  assert.equal(remainder, 'please fix the bug in handler.ts');
});

test('splits an <agents_md> block out of the remainder', () => {
  const { blocks, remainder } = splitInjectedBlocks(
    '<agents_md>\n# Guidance\nDo X.\n</agents_md>\n\nPlease do the thing.',
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tag, 'agents_md');
  assert.equal(blocks[0].content, '# Guidance\nDo X.');
  assert.equal(remainder, 'Please do the thing.');
});

test('splits multiple blocks and preserves the human request text', () => {
  const text = [
    '<agents_md>\nfollow conventions\n</agents_md>',
    '',
    'Fix the flaky test.',
    '',
    '<github_context>\nRepository: foo/bar\nIssue #1: title\n</github_context>',
    '<github_access>\ngit is authenticated\n</github_access>',
  ].join('\n');

  const { blocks, remainder } = splitInjectedBlocks(text);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.tag), ['agents_md', 'github_context', 'github_access']);
  assert.equal(blocks[0].content, 'follow conventions');
  assert.equal(blocks[1].content, 'Repository: foo/bar\nIssue #1: title');
  assert.equal(blocks[2].content, 'git is authenticated');
  assert.equal(remainder, 'Fix the flaky test.');
});

test('empty block content is dropped', () => {
  const { blocks, remainder } = splitInjectedBlocks('<agents_md></agents_md>\n\nDo the thing.');
  assert.deepEqual(blocks, []);
  assert.equal(remainder, 'Do the thing.');
});
