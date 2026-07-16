import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mintInstallationToken } from '../_shared/githubAppToken';
import { logGroupName, logStreamName, ensureLogStream, buildLiveTailUrl } from '../_shared/liveTail';
import { sanitizeHarmony } from '../../../lib/harmony-sanitize';
import { friendlyHarnessError } from '../../../lib/harness-error-message';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? '';
const GITHUB_APP_PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '';
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? '';
const JIRA_API_EMAIL = process.env.JIRA_API_EMAIL ?? '';
const JIRA_API_TOKEN_SECRET_ARN = process.env.JIRA_API_TOKEN_SECRET_ARN ?? '';
const HOSTING_DOMAIN = process.env.HOSTING_DOMAIN ?? '';
const BRANCH_SLUG = process.env.BRANCH_SLUG ?? '';

// Labels the Step Function manages around a label-triggered run (issue #56):
// `agent-working` while the agent runs, `agent-error` if it fails.
const WORKING_LABEL = 'agent-working';
const ERROR_LABEL = 'agent-error';

interface PostCommentInput {
  runId: string;
  source: 'github' | 'jira';
  stage: 'initial' | 'final';
  // github
  repo?: string;
  issueNumber?: number;
  // jira
  issueKey?: string;
  // final stage only — the failure path sends a plain responseText (the error
  // cause); the success path sends responseContent, the native invokeHarness
  // result's Message.Content array (which may be empty).
  responseText?: string;
  responseContent?: Array<{ Text?: string }>;
  // 'label' when the run was started by the `agentcore` label, 'comment' for an
  // @-mention comment. Both GitHub triggers get the agent-working/agent-error
  // label bookkeeping below (issue #77); Jira runs (no repo/issueNumber) skip it.
  trigger?: 'label' | 'comment';
  // Set on the final stage reached via the Step Function's failure Catch, so
  // this stage adds `agent-error` in addition to removing `agent-working`.
  isError?: boolean;
}

interface PostCommentOutput {
  logGroupName?: string;
  logStreamName?: string;
  githubToken?: string;
  githubTokenExpiresAt?: string;
  agentsSystemPrompt?: string;
}

async function postGithubComment(repo: string, issueNumber: number, body: string): Promise<{ token: string; expiresAt: string }> {
  if (!GITHUB_APP_PRIVATE_KEY_SECRET_ARN) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_SECRET_ARN not configured');
  }
  const { token, expiresAt } = await mintInstallationToken(repo, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN);

  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`GitHub createComment failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return { token, expiresAt };
}

// Add/remove a GitHub label using an already-minted installation token.
// Best-effort: label bookkeeping must never fail the run, so callers swallow
// errors. `addLabel` is idempotent (GitHub ignores a label already present);
// `removeLabel` treats a 404 (label not on the issue) as success.
async function addLabel(repo: string, issueNumber: number, token: string, label: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) throw new Error(`GitHub addLabel(${label}) failed (HTTP ${res.status}): ${await res.text()}`);
}

async function removeLabel(repo: string, issueNumber: number, token: string, label: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub removeLabel(${label}) failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

const secretsManager = new SecretsManagerClient({ region: REGION });

async function getJiraApiToken(): Promise<string> {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: JIRA_API_TOKEN_SECRET_ARN }));
  const token = result.SecretString;
  if (!token) throw new Error('Jira API token secret has no SecretString');
  return token;
}

async function postJiraComment(issueKey: string, body: string): Promise<void> {
  if (!JIRA_BASE_URL || !JIRA_API_EMAIL || !JIRA_API_TOKEN_SECRET_ARN) {
    throw new Error('JIRA_BASE_URL / JIRA_API_EMAIL / JIRA_API_TOKEN_SECRET_ARN not configured');
  }
  const token = await getJiraApiToken();
  const auth = Buffer.from(`${JIRA_API_EMAIL}:${token}`).toString('base64');

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Jira addComment failed (HTTP ${res.status}): ${await res.text()}`);
  }
}

export const handler = async (input: PostCommentInput): Promise<PostCommentOutput> => {
  const sourceSlug = input.source === 'github' ? (input.repo ?? 'github').replace(/\//g, '-') : (input.issueKey ?? 'jira').split('-')[0];
  const groupName = logGroupName(sourceSlug);
  const streamName = logStreamName(input.runId);

  if (input.stage === 'initial') {
    await ensureLogStream(groupName, streamName);
    const accountId = process.env.ACCOUNT_ID ?? '';
    const liveTailUrl = accountId
      ? buildLiveTailUrl(REGION, accountId, groupName, streamName)
      : null;

    let chatUrl: string | null = null;
    if (HOSTING_DOMAIN && BRANCH_SLUG) {
      chatUrl = `https://${HOSTING_DOMAIN}/${BRANCH_SLUG}/chat?sessionId=${input.runId}`;
    }
    const links = [];
    if (chatUrl) links.push(`[watch live in the chat UI](${chatUrl})`);
    if (liveTailUrl) links.push(`[watch live via CloudWatch Logs Live Tail](${liveTailUrl})`);
    const body = links.length
      ? `🤖 Working on it — ${links.join(' · ')}`
      : `🤖 Working on it (run \`${input.runId}\`)…`;

    let githubToken: string | undefined;
    let githubTokenExpiresAt: string | undefined;
    let agentsSystemPrompt: string | undefined;

    if (input.source === 'github') {
      if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
      const minted = await postGithubComment(input.repo, input.issueNumber, body);
      githubToken = minted.token;
      githubTokenExpiresAt = minted.expiresAt;

      // Attempt to fetch AGENTS.md from the repo root. If it exists, include its content as a system prompt.
      try {
        const agentsRes = await fetch(`https://api.github.com/repos/${input.repo}/contents/AGENTS.md`, {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (agentsRes.ok) {
          const agentsData = await agentsRes.json();
          // The content field is base64-encoded.
          if (agentsData.content) {
            agentsSystemPrompt = Buffer.from(agentsData.content, 'base64').toString('utf-8');
          }
        }
      } catch (e) {
        console.warn('Failed to fetch AGENTS.md:', e instanceof Error ? e.message : String(e));
      }

      // Mark the issue/PR as actively being worked on. Applied to both label-
      // and comment-mention triggered GitHub runs (issue #77) so the issue list
      // shows an at-a-glance "in progress" signal for either entry point, matching
      // .github/workflows/claude.yml which labels unconditionally. Best-effort —
      // never fail the run over label bookkeeping.
      if (input.trigger === 'label' || input.trigger === 'comment') {
        try {
          await addLabel(input.repo, input.issueNumber, minted.token, WORKING_LABEL);
        } catch (err) {
          console.warn(`Could not add ${WORKING_LABEL} label: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      if (!input.issueKey) throw new Error('issueKey required for jira source');
      await postJiraComment(input.issueKey, body);
    }

    return { logGroupName: groupName, logStreamName: streamName, githubToken, githubTokenExpiresAt, agentsSystemPrompt };
  }

  // Final stage — post the agent's response as a follow-up comment.
  // Success path: use only the last text block of the native invokeHarness result's
  // Message.Content (the integration omits tool-use/reasoning blocks, so this
  // can be empty). Failure path: responseText carries the error cause.
  const lastBlockText = (input.responseContent ?? [])
    .filter((block) => block?.Text)
    .map((block) => block?.Text ?? '')
    .pop();
  // On the failure path (input.responseText carries the raw error cause), turn a
  // recognized harness failure — chiefly context-window overflow (#140) — into a
  // concise, actionable message rather than posting the raw Bedrock exception.
  // Falls back to the raw cause for unrecognized errors.
  const failureText = input.responseText
    ? (friendlyHarnessError(input.responseText) ?? input.responseText)
    : undefined;
  // Strip any leaked Harmony special tokens (<|channel|>/<|message|>/…) the
  // gpt-oss-120b harness can emit into the plain-text block (issue #105) before
  // posting. Applied to both the success text and the failure cause so neither
  // path posts raw model markup. sanitizeHarmony is a no-op on clean text.
  const responseText = sanitizeHarmony(
    failureText
      ?? (lastBlockText?.trim() || '_The agent finished but produced no text response (it may have ended on a tool action). See the CloudWatch logs linked above._'),
  );
  if (input.source === 'github') {
    if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
    const { token } = await postGithubComment(input.repo, input.issueNumber, responseText);

    // Clear agent-working now that the run is done, and flag agent-error if this
    // final stage was reached via the failure Catch. Applied to both label- and
    // comment-mention triggered runs (issue #77) so the working label added at
    // the initial stage is always cleared and failures are always flagged.
    // Best-effort — a label API hiccup must not fail the whole execution.
    if (input.trigger === 'label' || input.trigger === 'comment') {
      try {
        await removeLabel(input.repo, input.issueNumber, token, WORKING_LABEL);
        if (input.isError) {
          await addLabel(input.repo, input.issueNumber, token, ERROR_LABEL);
        }
      } catch (err) {
        console.warn(`Could not update labels: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    if (!input.issueKey) throw new Error('issueKey required for jira source');
    await postJiraComment(input.issueKey, responseText);
  }

  return {};
};
