import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubIssueContext } from './github-issue-context.ts';

const ISSUE_MESSAGE = [
  'Please implement this issue.',
  '',
  '<github_context>',
  'Repository: waltmayf/agents4energy',
  'Issue #454: Update page metadata to show issue number and title when on the chat page for @agentcore-claude',
  'State: open',
  'Author: @waltmayf',
  'Labels: agent-working',
  '',
  'Description:',
  'When invoking the agentcore-claude agent from github, have the page metadata include issue number and issue title.',
  '</github_context>',
].join('\n');

const PR_MESSAGE = [
  '<github_context>',
  'Repository: waltmayf/agents4energy',
  'Pull request #123: Fix the thing',
  'State: open',
  'Author: @someone',
  'Labels: (none)',
  '</github_context>',
].join('\n');

test('parseGithubIssueContext extracts the issue number, title, and repo', () => {
  const result = parseGithubIssueContext(ISSUE_MESSAGE);
  assert.deepEqual(result, {
    kind: 'issue',
    number: 454,
    title: 'Update page metadata to show issue number and title when on the chat page for @agentcore-claude',
    repo: 'waltmayf/agents4energy',
  });
});

test('parseGithubIssueContext recognizes a pull request context', () => {
  const result = parseGithubIssueContext(PR_MESSAGE);
  assert.deepEqual(result, {
    kind: 'pull_request',
    number: 123,
    title: 'Fix the thing',
    repo: 'waltmayf/agents4energy',
  });
});

test('parseGithubIssueContext returns null for a regular (non-webhook) message', () => {
  assert.equal(parseGithubIssueContext('What is the well status?'), null);
});

test('parseGithubIssueContext returns null when the block is malformed', () => {
  assert.equal(parseGithubIssueContext('<github_context>\nRepository: foo/bar\n</github_context>'), null);
});
