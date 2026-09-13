/**
 * Parsing the `<github_context>` block PrepareGitAuth (the shared step behind
 * both the MyHarness and Claude Code webhook branches — see
 * `buildGithubContextBlock` in
 * `web/amplify/functions/agent-webhook-invoke-agent/handler.ts`) prepends to
 * every `@agentcore`/`@agentcore-claude` GitHub-driven run's first prompt.
 * That block always starts with an `Issue #N: <title>` or
 * `Pull request #N: <title>` line, so parsing it from the session's first
 * user message (issue #454) lets the chat tab title identify a GitHub-driven
 * conversation without any backend change.
 */

export interface GithubIssueContext {
  kind: 'issue' | 'pull_request';
  number: number;
  title: string;
  repo: string | null;
}

const CONTEXT_BLOCK = /<github_context>([\s\S]*?)<\/github_context>/;
const REPO_LINE = /^Repository:\s*(.+)$/m;
const ISSUE_LINE = /^(Issue|Pull request) #(\d+):\s*(.+)$/m;

/**
 * Returns the issue/PR the first user message identifies as this session's
 * GitHub context, or `null` when the message carries no `<github_context>`
 * block (a regular, non-webhook chat).
 */
export function parseGithubIssueContext(firstUserMessage: string): GithubIssueContext | null {
  const block = CONTEXT_BLOCK.exec(firstUserMessage)?.[1];
  if (!block) return null;

  const issueMatch = ISSUE_LINE.exec(block);
  if (!issueMatch) return null;

  const repoMatch = REPO_LINE.exec(block);
  return {
    kind: issueMatch[1] === 'Issue' ? 'issue' : 'pull_request',
    number: Number(issueMatch[2]),
    title: issueMatch[3].trim(),
    repo: repoMatch ? repoMatch[1].trim() : null,
  };
}
