import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mintInstallationToken } from '../_shared/githubAppToken';
import { logGroupName, logStreamName, ensureLogStream, buildLiveTailUrl } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? '';
const GITHUB_APP_PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '';
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? '';
const JIRA_API_EMAIL = process.env.JIRA_API_EMAIL ?? '';
const JIRA_API_TOKEN_SECRET_ARN = process.env.JIRA_API_TOKEN_SECRET_ARN ?? '';

interface PostCommentInput {
  runId: string;
  source: 'github' | 'jira';
  stage: 'initial' | 'final';
  // github
  repo?: string;
  issueNumber?: number;
  // jira
  issueKey?: string;
  // final stage only
  responseText?: string;
}

interface PostCommentOutput {
  logGroupName?: string;
  logStreamName?: string;
  githubToken?: string;
  githubTokenExpiresAt?: string;
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

    const body = liveTailUrl
      ? `🤖 Working on it — [watch live via CloudWatch Logs Live Tail](${liveTailUrl})`
      : `🤖 Working on it (run \`${input.runId}\`)…`;

    let githubToken: string | undefined;
    let githubTokenExpiresAt: string | undefined;

    if (input.source === 'github') {
      if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
      const minted = await postGithubComment(input.repo, input.issueNumber, body);
      githubToken = minted.token;
      githubTokenExpiresAt = minted.expiresAt;
    } else {
      if (!input.issueKey) throw new Error('issueKey required for jira source');
      await postJiraComment(input.issueKey, body);
    }

    return { logGroupName: groupName, logStreamName: streamName, githubToken, githubTokenExpiresAt };
  }

  // Final stage — post the agent's response as a follow-up comment.
  const responseText = input.responseText ?? '(no response)';
  if (input.source === 'github') {
    if (!input.repo || input.issueNumber === undefined) throw new Error('repo/issueNumber required for github source');
    await postGithubComment(input.repo, input.issueNumber, responseText);
  } else {
    if (!input.issueKey) throw new Error('issueKey required for jira source');
    await postJiraComment(input.issueKey, responseText);
  }

  return {};
};
