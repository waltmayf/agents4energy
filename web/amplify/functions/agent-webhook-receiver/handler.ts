import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { verifyGithubSignature, verifyJiraSharedSecret, extractPromptAfterMention } from '../_shared/webhookVerify';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GITHUB_WEBHOOK_SECRET_ARN = process.env.GITHUB_WEBHOOK_SECRET_ARN ?? '';
const JIRA_WEBHOOK_SECRET_ARN = process.env.JIRA_WEBHOOK_SECRET_ARN ?? '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';

// Applying this label to a GitHub issue/PR triggers the agent, exactly like an
// `@webhook-agent` comment does — but the Step Function additionally manages the
// `agent-working` / `agent-error` labels around the run (see issue #56 and
// docs/webhook-stepfunction-integration.md "Label triggers").
const TRIGGER_LABEL = 'agentcore';

const secretsManager = new SecretsManagerClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });

// Cached across warm invocations — secrets don't change between requests.
const secretCache = new Map<string, string>();

async function getSecret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);
  if (cached) return cached;
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = result.SecretString;
  if (!value) throw new Error(`Secret ${arn} has no SecretString`);
  secretCache.set(arn, value);
  return value;
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

interface GithubIssueCommentPayload {
  action: string;
  comment: { id: number; body: string; user: { login: string; type: string } };
  issue: { number: number; title: string; body: string | null; pull_request?: unknown };
  repository: { full_name: string };
  sender: { login: string; type: string };
}

// `issues`/`pull_request` labeled events. GitHub sends the issue under `issue`
// and PRs under `pull_request`; both carry number/title/body and a top-level
// `label` for the label that was just added. issueKey/comment fields are absent.
interface GithubLabeledPayload {
  action: string;
  label?: { name: string };
  issue?: { number: number; title: string; body: string | null };
  pull_request?: { number: number; title: string; body: string | null };
  repository: { full_name: string };
  sender: { login: string; type: string };
}

interface JiraCommentPayload {
  webhookEvent: string;
  issue: { key: string; fields: { summary: string; project: { key: string } } };
  comment: { body: string; author: { accountId: string; displayName: string } };
}

// Runs behind an API Gateway HTTP API with no built-in auth — GitHub/Jira
// can't do SigV4/Cognito, so per-source signature verification (below) is
// the only gate. Always returns 200 quickly (StartExecution is fire-and-forget)
// so neither GitHub's ~10s nor Jira's webhook timeout is ever at risk; the
// Step Function does the actual (multi-minute) agent work asynchronously.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const rawBody = event.body ?? '';
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  const isGithub = headers['x-github-event'] !== undefined;
  const isJira = event.queryStringParameters?.source === 'jira';

  if (isGithub) {
    const githubEvent = headers['x-github-event'];
    // Two GitHub triggers: an `@webhook-agent` mention in a new comment, or the
    // `agentcore` label applied to an issue/PR. Everything else is ignored.
    if (githubEvent !== 'issue_comment' && githubEvent !== 'issues' && githubEvent !== 'pull_request') {
      return json(200, { skipped: `unsupported github event: ${githubEvent}` });
    }
    if (!GITHUB_WEBHOOK_SECRET_ARN) {
      return json(500, { error: 'GITHUB_WEBHOOK_SECRET_ARN not configured' });
    }
    const secret = await getSecret(GITHUB_WEBHOOK_SECRET_ARN);
    if (!verifyGithubSignature(rawBody, headers['x-hub-signature-256'], secret)) {
      return json(401, { error: 'invalid signature' });
    }

    // ── Label trigger: `agentcore` added to an issue or PR ──────────────────
    if (githubEvent === 'issues' || githubEvent === 'pull_request') {
      const payload: GithubLabeledPayload = JSON.parse(rawBody);
      if (payload.action !== 'labeled') return json(200, { skipped: `action=${payload.action}` });
      if (payload.label?.name !== TRIGGER_LABEL) {
        return json(200, { skipped: `label=${payload.label?.name ?? '(none)'}` });
      }

      // Loop prevention — ignore labels applied by bots (e.g. our own automation).
      const senderLogin = payload.sender?.login ?? '';
      const senderType = payload.sender?.type ?? '';
      if (senderType === 'Bot' || senderLogin.endsWith('[bot]')) {
        return json(200, { skipped: 'bot sender' });
      }

      const target = payload.issue ?? payload.pull_request;
      if (!target) return json(200, { skipped: 'no issue/pull_request in payload' });

      const runId = randomUUID();
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `github-${payload.repository.full_name.replace(/\//g, '-')}-${target.number}-${runId}`,
        input: JSON.stringify({
          runId,
          source: 'github',
          // Signals the Step Function to manage the agent-working/agent-error
          // labels around the run (a comment-mention run leaves labels alone).
          trigger: 'label',
          repo: payload.repository.full_name,
          issueNumber: target.number,
          issueKey: null,
          prompt: [
            `Work on this GitHub ${payload.pull_request ? 'pull request' : 'issue'}: #${target.number} — ${target.title}`,
            '',
            target.body ?? '',
          ].join('\n'),
          sender: senderLogin,
        }),
      }));

      return json(202, { started: runId });
    }

    // ── Comment-mention trigger: `@webhook-agent <prompt>` ──────────────────
    const payload: GithubIssueCommentPayload = JSON.parse(rawBody);
    if (payload.action !== 'created') return json(200, { skipped: `action=${payload.action}` });

    // Loop prevention — never respond to bot-authored comments (including our own replies).
    const senderLogin = payload.sender?.login ?? '';
    const senderType = payload.sender?.type ?? '';
    if (senderType === 'Bot' || senderLogin.endsWith('[bot]')) {
      return json(200, { skipped: 'bot sender' });
    }

    const prompt = extractPromptAfterMention(payload.comment.body);
    if (prompt === null) return json(200, { skipped: 'no trigger mention' });

    const runId = randomUUID();
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `github-${payload.repository.full_name.replace(/\//g, '-')}-${payload.issue.number}-${runId}`,
      input: JSON.stringify({
        runId,
        source: 'github',
        trigger: 'comment',
        repo: payload.repository.full_name,
        issueNumber: payload.issue.number,
        issueKey: null,
        prompt: prompt || payload.issue.title,
        sender: senderLogin,
      }),
    }));

    return json(202, { started: runId });
  }

  if (isJira) {
    if (!JIRA_WEBHOOK_SECRET_ARN) {
      return json(500, { error: 'JIRA_WEBHOOK_SECRET_ARN not configured' });
    }
    const secret = await getSecret(JIRA_WEBHOOK_SECRET_ARN);
    if (!verifyJiraSharedSecret(event.queryStringParameters?.secret, secret)) {
      return json(401, { error: 'invalid secret' });
    }

    const payload: JiraCommentPayload = JSON.parse(rawBody);
    if (payload.webhookEvent !== 'comment_created') {
      return json(200, { skipped: `webhookEvent=${payload.webhookEvent}` });
    }

    const prompt = extractPromptAfterMention(payload.comment.body);
    if (prompt === null) return json(200, { skipped: 'no trigger mention' });

    const runId = randomUUID();
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `jira-${payload.issue.key}-${runId}`,
      input: JSON.stringify({
        runId,
        source: 'jira',
        trigger: 'comment',
        repo: null,
        issueNumber: null,
        issueKey: payload.issue.key,
        projectKey: payload.issue.fields.project.key,
        prompt: prompt || payload.issue.fields.summary,
        sender: payload.comment.author.displayName,
      }),
    }));

    return json(202, { started: runId });
  }

  return json(400, { error: 'unrecognized webhook source — expected X-GitHub-Event header or ?source=jira' });
};
