import { createHmac, timingSafeEqual } from 'crypto';

// GitHub signs the raw request body with the webhook secret as
// `X-Hub-Signature-256: sha256=<hex hmac>`. See
// https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
export function verifyGithubSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// Jira Cloud's classic (REST-API-registered or Connect-app-descriptor)
// webhooks have no HMAC signing scheme equivalent to GitHub's — Atlassian
// only signs webhooks for Connect/Forge apps via asymmetric JWT, which
// requires a full app installation flow. For a plain REST webhook, a
// shared secret passed as a query parameter (compared with a constant-time
// check) is the standard workaround recommended by Atlassian support docs.
// See docs/webhook-stepfunction-integration.md for the tradeoff.
export function verifyJiraSharedSecret(providedSecret: string | undefined, expectedSecret: string): boolean {
  if (!providedSecret) return false;
  const expectedBuf = Buffer.from(expectedSecret);
  const actualBuf = Buffer.from(providedSecret);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// `@agentcore-claude` routes to the Claude Code AgentCore Runtime (the
// container agent in agent/default/app/ClaudeCode); a bare `@agentcore` routes
// to MyHarness. Note `/@agentcore\b/` ALSO matches `@agentcore-claude` (the
// word boundary sits between "agentcore" and "-"), so the claude pattern must
// be tested first — see parseMention.
const CLAUDE_MENTION_RE = /@agentcore-claude\b/i;
const HARNESS_MENTION_RE = /@agentcore\b/i;

/** Which agent a webhook comment addressed. */
export type MentionedAgent = 'harness' | 'claude';

// Returns the addressed agent and the prompt text following the trigger
// mention, or null if no trigger mention is present. A distinct mention phrase
// (rather than reusing `@agent-<slug>`) keeps this webhook path from
// double-firing alongside .github/workflows/agent-mention.yml, which already
// matches any `@agent[-<slug>]` mention on the same repo.
export function parseMention(commentBody: string): { agent: MentionedAgent; prompt: string } | null {
  // Claude first — `@agentcore-claude` also satisfies HARNESS_MENTION_RE.
  if (CLAUDE_MENTION_RE.test(commentBody)) {
    return { agent: 'claude', prompt: commentBody.replace(CLAUDE_MENTION_RE, '').trim() };
  }
  if (HARNESS_MENTION_RE.test(commentBody)) {
    return { agent: 'harness', prompt: commentBody.replace(HARNESS_MENTION_RE, '').trim() };
  }
  return null;
}

// Back-compat thin wrapper — returns just the prompt for the harness/claude
// mention, or null. Prefer parseMention when the addressed agent matters.
export function extractPromptAfterMention(commentBody: string): string | null {
  return parseMention(commentBody)?.prompt ?? null;
}
