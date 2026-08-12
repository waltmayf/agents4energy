import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  SFNClient,
  StartExecutionCommand,
  ListExecutionsCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { verifyGithubSignature, verifyJiraSharedSecret, extractPromptAfterMention, parseMention } from '../_shared/webhookVerify';
import { execName, sharedNamePrefix } from '../../../lib/exec-name';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
// GitHub HMAC secret value, injected directly by Amplify's secret() (issue
// #239) — the handler compares against it with no runtime Secrets Manager call.
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
// Jira stays on the optional ARN pattern (fetched from Secrets Manager below).
const JIRA_WEBHOOK_SECRET_ARN = process.env.JIRA_WEBHOOK_SECRET_ARN ?? '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';
// Lets the receiver reach into the Claude Code runtime and kill a superseded
// background job (issue #182's data plane, already built in server.js — see
// agent/default/app/ClaudeCode/server.js). Empty on branches that don't deploy
// the runtime, in which case cancelRuntimeJob is a no-op and cancelPriorRuns
// falls back to StopExecution only.
const CLAUDE_CODE_RUNTIME_ARN = process.env.CLAUDE_CODE_RUNTIME_ARN ?? '';

// Applying this label to a GitHub issue/PR triggers the agent, exactly like an
// `@agentcore` comment does — but the Step Function additionally manages the
// `agent-working` / `agent-error` labels around the run (see issue #56 and
// docs/webhook-stepfunction-integration.md "Label triggers").
const TRIGGER_LABEL = 'agentcore';

// Who may invoke the agent from a comment mention. GitHub stamps each comment
// with the commenter's `author_association` to the repo; OWNER/MEMBER/
// COLLABORATOR all imply write or admin access, whereas CONTRIBUTOR,
// FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, MANNEQUIN, and NONE do not. Gating on
// this (no extra API call — it's already in the webhook payload) stops an
// untrusted commenter from steering an agent that holds repo-write credentials
// and can run arbitrary shell in its session. The label trigger needs no such
// check: GitHub only lets users with triage/write/admin permission apply a
// label in the first place, so reaching the labeled event already proves trust.
const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Our own GitHub App's bot login (webhook `sender.login` for a comment it
// posts is always `<name>[bot]`). This is the ONE bot sender ever let through
// the loop-prevention check in the comment-mention branch below, and only for
// a comment that already carries a valid `@agentcore-claude`/`@agentcore`
// trigger mention — see issue #395. Every other bot (and our own non-mention
// replies, e.g. "Working on it") is still skipped. Must match
// `scripts/lib/agents-wait-config.sh`'s `_DEFAULT_BOT` — keep them in sync if
// the App is ever renamed.
const OWN_APP_BOT_LOGIN = 'waltmayf-claude-code-app[bot]';

const secretsManager = new SecretsManagerClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });
// Only used to fire the cancel control payload at the Claude Code runtime
// (issue #182's data plane, see agent/default/app/ClaudeCode/server.js) before
// stopping a superseded execution. Same runtime the invoke-claude Lambda calls.
const agentCore = new BedrockAgentCoreClient({ region: REGION });

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

// Best-effort: fetch a RUNNING execution's original StartExecution input so we
// can recover its runId/agent (the name alone may have a hashed/truncated
// runId — see execName — so it can't be parsed back out reliably).
async function describeExecutionInput(executionArn: string): Promise<{ runId?: string; agent?: string } | null> {
  try {
    const resp = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    if (!resp.input) return null;
    return JSON.parse(resp.input);
  } catch {
    return null;
  }
}

// Cause reported (via SendTaskFailure) when a run is cancelled. Mirrors the
// runtime's own SUPERSEDED_CAUSE (agent/default/app/ClaudeCode/server.js) —
// deliberately contains no raw "@" mention so the PostFailureComment note it
// produces can never re-trigger the webhook.
const SUPERSEDED_ERROR = 'SupersededByNewerComment';

// Reach into the Claude Code AgentCore Runtime and abort the in-flight job for
// a prior run (issue #182's data plane — see server.js's `action: 'cancel'`
// handler). SIGTERMs the spawned CLI; the runtime then calls SendTaskFailure
// itself (asynchronously, after the process actually exits), which resumes the
// prior run's PAUSED Step Functions task through its existing Catch →
// PostFailureComment wiring — so the superseded run still posts a clean
// terminal comment. Returns true once the runtime has ACCEPTED the cancel
// request (not once the job has actually died) — callers must not also call
// StopExecution in that case: since the actual kill+SendTaskFailure happens
// after this returns, StopExecution racing it would abort the execution before
// Catch → PostFailureComment fires, and the superseded run would post no
// comment at all. Only fall back to StopExecution when this returns false —
// runtime not deployed, session already reclaimed, or the invoke itself
// failed — since then nothing else will ever stop the prior execution.
async function cancelRuntimeJob(runId: string, log: (msg: string) => void): Promise<boolean> {
  if (!CLAUDE_CODE_RUNTIME_ARN) return false;
  try {
    const resp = await agentCore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: CLAUDE_CODE_RUNTIME_ARN,
      // Same session id the run itself used (agent-webhook-invoke-claude sets
      // runtimeSessionId = runId), so this control payload lands on the exact
      // microVM running the job to kill.
      runtimeSessionId: runId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify({ action: 'cancel', runId })),
    }));
    if (resp.statusCode && resp.statusCode >= 400) {
      log(`cancelRuntimeJob for runId=${runId} got HTTP ${resp.statusCode}`);
      return false;
    }
    const raw = resp.response ? await resp.response.transformToString() : '';
    const body = raw ? JSON.parse(raw) : {};
    // `cancelled: false` means the runtime accepted the request but has no
    // matching in-flight job on this microVM — the run already finished, so
    // there is nothing to StopExecution either. Treat as "handled".
    log(`cancelRuntimeJob for runId=${runId}: ${raw || '(empty response)'}`);
    return body.cancelled !== false;
  } catch (err) {
    // Session already reclaimed/gone, AccessDenied, etc. — the runtime never
    // saw this, so the caller must fall back to StopExecution.
    log(`cancelRuntimeJob failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Control plane of issue #182: before starting a new run, find every prior
// RUNNING execution for the same target (matched by the shared name prefix —
// ListExecutions has no server-side name filter, so this filters client-side)
// and cancel it — last-write-wins, not debounce, so a "changed my mind"
// follow-up comment always supersedes rather than queuing behind stale work.
// Best-effort throughout: a failure here must never block the NEW run from
// starting (mirrors the label-bookkeeping best-effort pattern elsewhere in
// this pipeline).
async function cancelPriorRuns(namePrefix: string, log: (msg: string) => void): Promise<void> {
  if (!STATE_MACHINE_ARN) return;
  const prior: Array<{ executionArn: string; name: string }> = [];
  let nextToken: string | undefined;
  try {
    do {
      const resp = await sfn.send(new ListExecutionsCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        statusFilter: 'RUNNING',
        nextToken,
      }));
      for (const exec of resp.executions ?? []) {
        if (exec.executionArn && exec.name?.startsWith(namePrefix)) {
          prior.push({ executionArn: exec.executionArn, name: exec.name });
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch (err) {
    log(`ListExecutions failed for prefix "${namePrefix}": ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!prior.length) return;

  log(`found ${prior.length} prior RUNNING execution(s) matching prefix "${namePrefix}"; cancelling (last-write-wins)`);
  await Promise.all(prior.map(async ({ executionArn, name }) => {
    try {
      const input = await describeExecutionInput(executionArn);
      const priorRunId = typeof input?.runId === 'string' ? input.runId : '';
      if (priorRunId && input?.agent === 'claude') {
        // Kills the background job; the runtime resumes/fails its own paused
        // SFN task, so the execution finishes on its own via the existing
        // Catch wiring — see cancelRuntimeJob's doc for why StopExecution must
        // be skipped on this path. Only fall back to StopExecution if the
        // runtime never got the message (e.g. session already reclaimed).
        const handled = await cancelRuntimeJob(priorRunId, log);
        if (handled) return;
        log(`runtime cancel did not land for ${name}; falling back to StopExecution`);
      }
      // Harness/Jira runs have no detached background job (the native
      // invokeHarness task is bounded to its own 840s timeout and holds no
      // task token) — StopExecution alone is sufficient here. Also the
      // fallback for a claude run whose runtime cancel failed above.
      await sfn.send(new StopExecutionCommand({
        executionArn,
        error: SUPERSEDED_ERROR,
        cause: 'Cancelled: superseded by a newer agentcore comment on the same issue.',
      }));
      log(`stopped prior execution ${name}`);
    } catch (err) {
      log(`failed to cancel prior execution ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

interface GithubIssueCommentPayload {
  action: string;
  comment: {
    id: number;
    body: string;
    user: { login: string; type: string };
    // The commenter's relationship to the repo — OWNER/MEMBER/COLLABORATOR
    // imply write/admin; see AUTHORIZED_ASSOCIATIONS.
    author_association: string;
  };
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
// can't do SigV4/Cognito, so per-source signature verification (below) is the
// transport gate. GitHub comment mentions are additionally gated on the
// commenter's author_association (see AUTHORIZED_ASSOCIATIONS) so only repo
// write/admin users can drive the agent. Always returns 200 quickly (StartExecution is fire-and-forget)
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
    // Two GitHub triggers: an `@agentcore` mention in a new comment, or the
    // `agentcore` label applied to an issue/PR. Everything else is ignored.
    if (githubEvent !== 'issue_comment' && githubEvent !== 'issues' && githubEvent !== 'pull_request') {
      return json(200, { skipped: `unsupported github event: ${githubEvent}` });
    }
    if (!GITHUB_WEBHOOK_SECRET) {
      return json(500, { error: 'GITHUB_WEBHOOK_SECRET not configured' });
    }
    if (!verifyGithubSignature(rawBody, headers['x-hub-signature-256'], GITHUB_WEBHOOK_SECRET)) {
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
      const namePrefixBase = `github-${payload.repository.full_name.replace(/\//g, '-')}-${target.number}`;
      // Last-write-wins (issue #182): cancel any run already in flight for
      // this issue/PR before starting the new one.
      await cancelPriorRuns(sharedNamePrefix(namePrefixBase), (msg) => console.log(`[cancelPriorRuns][runId=${runId}]`, msg));
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: execName(namePrefixBase, runId),
        input: JSON.stringify({
          runId,
          source: 'github',
          // Signals the Step Function to manage the agent-working/agent-error
          // labels around the run (a comment-mention run leaves labels alone).
          trigger: 'label',
          // Label triggers always route to MyHarness — there's no per-label way
          // to pick the Claude Code runtime, and the label is named `agentcore`.
          agent: 'harness',
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

    // ── Comment-mention trigger: `@agentcore <prompt>` ──────────────────
    const payload: GithubIssueCommentPayload = JSON.parse(rawBody);
    if (payload.action !== 'created') return json(200, { skipped: `action=${payload.action}` });

    // Parse the mention BEFORE the bot-skip (issue #395): whether a bot sender
    // gets to trigger a run depends on whether it's carrying a mention at
    // all, so the mention parse can't happen after a blanket bot-skip has
    // already returned. Ordinary (non-mention) comments from anyone —
    // including our own automation's "Working on it" replies — still fall
    // through here untouched.
    const mention = parseMention(payload.comment.body);
    if (mention === null) return json(200, { skipped: 'no trigger mention' });

    // Loop prevention — drop every bot-authored mention EXCEPT our own App's
    // (the orchestrator dispatches workers by posting `@agentcore-claude` as
    // that same App — see #381/#395). This can't create an infinite loop:
    // workers dispatched this way never themselves post an `@agentcore-claude`
    // mention (they push a PR / comment plainly), so there is no cycle for
    // this allowlist to close. Any duplicate dispatch (e.g. a retried
    // delivery) is bounded by cancelPriorRuns' last-write-wins StopExecution
    // below, not by this check.
    const senderLogin = payload.sender?.login ?? '';
    const senderType = payload.sender?.type ?? '';
    const isBotSender = senderType === 'Bot' || senderLogin.endsWith('[bot]');
    const isOwnApp = senderLogin.toLowerCase() === OWN_APP_BOT_LOGIN.toLowerCase();
    if (isBotSender && !isOwnApp) {
      return json(200, { skipped: 'bot sender' });
    }

    // Authorization gate — skipped for our own App (it's the trusted
    // automation dispatching workers, not an external commenter, and a Bot
    // sender's author_association wouldn't reliably reflect write access
    // anyway). Humans still need write/admin on the repo — see
    // AUTHORIZED_ASSOCIATIONS; the agent holds repo-write credentials and runs
    // arbitrary shell, so this must stay strict for anyone else.
    if (!isOwnApp) {
      const association = payload.comment.author_association ?? '';
      if (!AUTHORIZED_ASSOCIATIONS.has(association)) {
        console.log(`[receiver] rejected mention from unauthorized sender=${senderLogin} association=${association || '(none)'}`);
        return json(200, { skipped: `unauthorized sender (association=${association || 'NONE'})` });
      }
    }

    const runId = randomUUID();
    const namePrefixBase = `github-${payload.repository.full_name.replace(/\//g, '-')}-${payload.issue.number}`;
    // Last-write-wins (issue #182): a newer @agentcore(-claude) comment on the
    // same issue/PR supersedes any run already in flight for it.
    await cancelPriorRuns(sharedNamePrefix(namePrefixBase), (msg) => console.log(`[cancelPriorRuns][runId=${runId}]`, msg));
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: execName(namePrefixBase, runId),
      input: JSON.stringify({
        runId,
        source: 'github',
        trigger: 'comment',
        // 'harness' (@agentcore) → MyHarness; 'claude' (@agentcore-claude) →
        // the Claude Code AgentCore Runtime. The Step Function branches on this.
        agent: mention.agent,
        repo: payload.repository.full_name,
        issueNumber: payload.issue.number,
        issueKey: null,
        prompt: mention.prompt || payload.issue.title,
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
    const namePrefixBase = `jira-${payload.issue.key}`;
    // Last-write-wins (issue #182): a newer comment on the same Jira issue
    // supersedes any run already in flight for it.
    await cancelPriorRuns(sharedNamePrefix(namePrefixBase), (msg) => console.log(`[cancelPriorRuns][runId=${runId}]`, msg));
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: execName(namePrefixBase, runId),
      input: JSON.stringify({
        runId,
        source: 'jira',
        trigger: 'comment',
        // Jira has no repo/git context, so the Claude Code runtime (which clones
        // and opens PRs) doesn't apply — always route Jira to MyHarness.
        agent: 'harness',
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
