import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseWebhookSections } from './collapse-webhook-sections.ts';

test('plain (non-webhook) message with none of the markers is returned unchanged', () => {
  const plain = 'Can you fix the flaky test in web/e2e/chat.spec.ts?';
  assert.equal(collapseWebhookSections(plain), plain);
});

test('collapses <agents_md> into a details widget and leaves the request visible', () => {
  const input = [
    '<agents_md>\n# CLAUDE.md\n\nSome instructions.\n</agents_md>',
    'Please fix the bug in the parser.',
  ].join('\n\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<details>'), 'wraps in a details element');
  assert.ok(out.includes('<summary>AGENTS.md instructions ▸</summary>'));
  assert.ok(out.includes('# CLAUDE.md'), 'keeps the AGENTS.md content inside the details');
  assert.ok(out.includes('Please fix the bug in the parser.'), 'request text stays visible');
  assert.ok(!out.includes('<agents_md>'), 'marker tag itself is gone');
});

test('collapses <comment_thread> with the comment count in the toggle', () => {
  const input = [
    '<github_context>',
    'Repository: foo/bar',
    'Issue #1: Something broke',
    'State: open',
    '',
    'Description:',
    'It broke.',
    '',
    '<comment_thread>',
    'Comment thread (2):',
    '--- @alice at 2026-01-01T00:00:00Z ---',
    'first comment',
    '--- @bob at 2026-01-02T00:00:00Z ---',
    'second comment',
    '</comment_thread>',
    '</github_context>',
  ].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>Prior GitHub comments (2) ▸</summary>'));
  assert.ok(out.includes('<summary>Issue #1: Something broke ▸</summary>'), 'github_context collapses under the issue title');
  assert.ok(out.includes('Repository: foo/bar'), 'issue metadata preserved inside the collapse');
  assert.ok(out.includes('first comment') && out.includes('second comment'), 'comment bodies preserved inside the collapse');
  assert.ok(!out.includes('<github_context>') && !out.includes('</github_context>'), 'wrapper marker tags are stripped');
  assert.ok(!out.includes('<comment_thread>'), 'comment_thread marker tag itself is gone');
});

test('collapses a "2+" (capped) comment count correctly', () => {
  const input = ['<comment_thread>', 'Comment thread (20+):', '--- @a at t ---', 'x', '</comment_thread>'].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>Prior GitHub comments (20+) ▸</summary>'));
});

test('collapses <github_access> into a details widget', () => {
  const input = [
    'Do the thing.',
    '',
    '<github_access>',
    'git and gh are already authenticated...',
    '</github_access>',
  ].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>GitHub access & delivery instructions ▸</summary>'));
  assert.ok(out.includes('git and gh are already authenticated...'));
  assert.ok(!out.includes('<github_access>'));
});

test('collapses all three sections together, matching the real handler.ts prompt shape', () => {
  const input = [
    '<agents_md>\nSome AGENTS.md content\n</agents_md>',
    '',
    'Fix issue #42.',
    '',
    '<github_context>',
    'Repository: foo/bar',
    'Issue #42: Bug',
    '',
    '<comment_thread>',
    'Comment thread (1):',
    '--- @carol at t ---',
    'a comment',
    '</comment_thread>',
    '</github_context>',
    '',
    '<github_access>',
    'auth details',
    '</github_access>',
  ].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>AGENTS.md instructions ▸</summary>'));
  assert.ok(out.includes('<summary>Prior GitHub comments (1) ▸</summary>'));
  assert.ok(out.includes('<summary>GitHub access & delivery instructions ▸</summary>'));
  assert.ok(out.includes('<summary>Issue #42: Bug ▸</summary>'), 'github_context collapses under the issue title');
  assert.ok(out.includes('Fix issue #42.'), 'the actual request text remains visible and uncollapsed');
  assert.ok(out.includes('Repository: foo/bar'), 'issue metadata preserved inside the github_context collapse');
  for (const tag of ['<agents_md>', '<comment_thread>', '<github_context>', '<github_access>']) {
    assert.ok(!out.includes(tag), `${tag} marker is gone from the output`);
  }
});

test('collapses <github_context> under a PR title summary, sub-collapsing the comment thread', () => {
  const input = [
    'Review this PR.',
    '',
    '<github_context>',
    'Repository: foo/bar',
    'Pull request #7: Add widget',
    'State: open',
    '',
    'Description:',
    'Adds a widget.',
    '',
    'Base branch: main  Head branch: feat/widget',
    'Changed files: 1 (+10 / -0)',
    '  added: src/widget.ts (+10 / -0)',
    '<comment_thread>',
    'Comment thread (1):',
    '--- @dave at t ---',
    'looks good',
    '</comment_thread>',
    '</github_context>',
  ].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>Pull request #7: Add widget ▸</summary>'), 'uses the PR title as the toggle summary');
  assert.ok(out.includes('Review this PR.'), 'request text stays visible');
  assert.ok(out.includes('src/widget.ts'), 'PR file list preserved inside the collapse');
  assert.ok(out.includes('<summary>Prior GitHub comments (1) ▸</summary>'), 'comment thread stays sub-collapsed');
  assert.ok(out.includes('looks good'), 'comment body preserved');
  for (const tag of ['<github_context>', '<comment_thread>']) {
    assert.ok(!out.includes(tag), `${tag} marker is gone`);
  }
});

test('falls back to a generic github_context summary when no title line is present', () => {
  const input = ['<github_context>', 'Repository: foo/bar', 'State: open', '</github_context>'].join('\n');
  const out = collapseWebhookSections(input);
  assert.ok(out.includes('<summary>GitHub context ▸</summary>'), 'generic summary when title line missing');
  assert.ok(out.includes('Repository: foo/bar'), 'content preserved inside the collapse');
});
