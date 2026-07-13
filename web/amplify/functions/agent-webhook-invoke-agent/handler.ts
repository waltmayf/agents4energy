import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  InvokeAgentRuntimeCommandCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const HARNESS_ARN = process.env.HARNESS_ARN ?? '';

// The harness authorizes with AWS_IAM, so the SDK client signs every request
// with this Lambda's execution-role credentials (SigV4) — no Cognito JWT. The
// SDK also owns connection timeouts + retries and decodes the event stream
// into typed objects, so the hand-rolled binary decoder (and the long-stream
// `TypeError: terminated` it hit, #57) are both gone.
const agentCore = new BedrockAgentCoreClient({ region: REGION });

interface InvokeAgentInput {
  runId: string;
  source: 'github' | 'jira';
  prompt: string;
  repo: string | null;
  issueNumber: number | null;
  issueKey: string | null;
  githubToken?: string | null;
  logGroupName?: string;
  logStreamName?: string;
}

interface InvokeAgentOutput {
  response: string;
}

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Logging is best-effort — never fail the agent invocation because a log write failed.
  }
}

// Runs a shell command in the harness's runtime session via the harness-exec
// API (InvokeAgentRuntimeCommand → POST /runtimes/{harnessArn}/commands),
// keyed by the same runtimeSessionId the subsequent InvokeHarness call uses so
// both land in the same container. Two things carried over from #52/#53:
//   1. `agentRuntimeArn` here takes the **harness** ARN, not the backing
//      runtime ARN. Calling the runtime ARN directly returns HTTP 400
//      "managed by a harness and cannot be invoked directly".
//   2. The harness now authorizes with AWS_IAM, so this is SigV4-signed via the
//      SDK client above (the earlier CUSTOM_JWT setup required a Cognito Bearer
//      token and a hand-rolled fetch; that's gone).
// The SDK yields typed `chunk` events carrying contentDelta (stdout/stderr) and
// a final contentStop (exitCode).
async function execInHarness(opts: {
  sessionId: string;
  command: string;
  timeoutSeconds?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sessionId, command, timeoutSeconds = 120 } = opts;

  if (!HARNESS_ARN) throw new Error('HARNESS_ARN not configured');

  const response = await agentCore.send(new InvokeAgentRuntimeCommandCommand({
    agentRuntimeArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    body: { command, timeout: timeoutSeconds },
  }));

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;

  for await (const event of response.stream ?? []) {
    if (event.validationException || event.accessDeniedException || event.resourceNotFoundException
      || event.throttlingException || event.serviceQuotaExceededException
      || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.accessDeniedException ?? event.resourceNotFoundException
        ?? event.throttlingException ?? event.serviceQuotaExceededException
        ?? event.internalServerException ?? event.runtimeClientError;
      throw new Error(`Harness exec stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    }
    const chunk = event.chunk;
    if (chunk?.contentDelta?.stdout) stdout += chunk.contentDelta.stdout;
    if (chunk?.contentDelta?.stderr) stderr += chunk.contentDelta.stderr;
    if (typeof chunk?.contentStop?.exitCode === 'number') exitCode = chunk.contentStop.exitCode;
  }

  return { exitCode: exitCode ?? -1, stdout, stderr };
}

// Authenticate `git` for HTTPS pushes in the harness session, before the
// agent's turn, by seeding a credential-store file with the GitHub App
// installation token minted by agent-webhook-post-comment.
//
// We deliberately do NOT use `gh` here: the harness image (Amazon Linux 2023)
// ships `git` but not `gh`, and `gh` can't be cleanly installed at exec time
// (no `cpio`, `gh` absent from the AL2023 repos, `rpm -i` rejects the official
// package as non-relocatable). Tracked in #54. Until then the agent opens PRs
// with a GitHub compare URL (see the <github_access> block below) rather than
// `gh pr create`.
//
// The token travels once in this exec request body (TLS-encrypted, not visible
// to the model) and is then stored in the session's ~/.git-credentials; the
// agent's subsequent tool calls never receive it, matching the AgUiHandler's
// _prepare_workspace().
async function authenticateGitInHarnessSession(opts: {
  sessionId: string;
  githubToken: string;
}): Promise<void> {
  const { sessionId, githubToken } = opts;

  // JSON.stringify safely quotes the token for the shell (printf '%s' "<tok>")
  // and, being the body of an SDK request, is never echoed to the model.
  const command = [
    'set -e',
    'git config --global user.name "webhook-agent[bot]"',
    'git config --global user.email "webhook-agent[bot]@users.noreply.github.com"',
    'git config --global credential.helper store',
    `printf 'https://x-access-token:%s@github.com\\n' ${JSON.stringify(githubToken)} > "$HOME/.git-credentials"`,
    'chmod 600 "$HOME/.git-credentials"',
  ].join(' && ');

  const { exitCode, stderr } = await execInHarness({ sessionId, command, timeoutSeconds: 60 });
  if (exitCode !== 0) {
    throw new Error(`Harness exec for git auth exited with code ${exitCode}: ${stderr.trim()}`);
  }
}

// Invoke the AgentCore Harness via the SDK's InvokeHarnessCommand (SigV4-signed
// against the harness ARN — the same target the browser transport and the
// invoke-agent Lambda use). The SDK returns a typed event stream; accumulate
// its contentBlockDelta text into the full response, and surface validation /
// server exception events instead of silently returning empty text.
async function invokeHarness(opts: {
  sessionId: string;
  prompt: string;
}): Promise<string> {
  const { sessionId, prompt } = opts;

  if (!HARNESS_ARN) throw new Error('HARNESS_ARN not configured');

  const response = await agentCore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
  }));

  const chunks: string[] = [];

  for await (const event of response.stream ?? []) {
    // A bad model id / malformed request surfaces here as a validation or
    // internal-server exception event — throw it rather than returning
    // "(no response)", which is what previously masked such failures.
    if (event.validationException || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
      throw new Error(`Harness stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    }
    const text = event.contentBlockDelta?.delta?.text;
    if (text) chunks.push(text);
  }

  return chunks.join('');
}

export const handler = async (input: InvokeAgentInput): Promise<InvokeAgentOutput> => {
  const { runId, source, prompt, repo, githubToken, logGroupName, logStreamName } = input;

  let effectivePrompt = prompt;

  if (source === 'github' && githubToken) {
    await log(logGroupName, logStreamName, `[${runId}] authenticating git in harness session`);
    await authenticateGitInHarnessSession({ sessionId: runId, githubToken });

    // The exec call above authenticated `git` for HTTPS pushes in this
    // session's shell — tell the agent that so it clones/pushes with its code
    // interpreter tool instead of assuming (as it did in #48) that it lacks
    // write access. `gh` is NOT installed in the harness (see #54), so the
    // agent opens a PR by printing a GitHub compare URL rather than running
    // `gh pr create`; the Step Function posts the agent's reply back to the
    // issue, so the link reaches the user there.
    if (repo) {
      effectivePrompt = [
        prompt,
        '',
        '<github_access>',
        `Your code interpreter\'s git CLI is already authenticated for the repository ${repo} over HTTPS — git clone/commit/push all work with no token setup needed.`,
        `Clone with: git clone https://github.com/${repo}.git`,
        'Commit and push your branch normally (e.g. git push -u origin <your-branch>).',
        'The `gh` CLI is NOT available. To open a pull request, do NOT try to run `gh`. Instead, after pushing your branch, construct a GitHub "compare" URL and include it in your reply as a clickable link the user can click to open the PR:',
        `  https://github.com/${repo}/compare/<base-branch>...<your-branch>?quick_pull=1&title=<url-encoded-title>&body=<url-encoded-body>`,
        'The base branch is normally `main`. URL-encode the title and body. End your reply with that link so the user can open the PR in one click.',
        '</github_access>',
      ].join('\n');
    }
  }

  await log(logGroupName, logStreamName, `[${runId}] invoking harness (source=${source})`);

  // The harness invoke is a single blocking event-stream read (fully consumed
  // below before returning), so emit a heartbeat every 20s while waiting. This
  // is the best "live" signal available without streaming step-by-step events
  // into this run's log stream — see docs/webhook-stepfunction-integration.md.
  const heartbeat = setInterval(() => {
    void log(logGroupName, logStreamName, `[${runId}] still running…`);
  }, 20_000);

  try {
    const response = await invokeHarness({ sessionId: runId, prompt: effectivePrompt });
    const finalText = response || '(no response)';

    await log(logGroupName, logStreamName, `[${runId}] harness responded (${finalText.length} chars)`);
    return { response: finalText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(logGroupName, logStreamName, `[${runId}] harness invocation failed: ${message}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
};
