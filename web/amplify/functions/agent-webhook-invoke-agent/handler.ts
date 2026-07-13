import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommandCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const HARNESS_ARN = process.env.HARNESS_ARN ?? '';

// This step no longer invokes the harness — that is now a native Step Functions
// `bedrockagentcore:invokeHarness` task (see docs/webhook-stepfunction-integration.md
// and issue #56). What remains here is the one piece the native integration
// cannot do: run a shell command in the harness's runtime session to seed git
// credentials *before* the agent turn, and hand the annotated prompt back to the
// state machine. The command's stdout/stderr are written to the run's CloudWatch
// Logs stream so a failed clone/push is debuggable there.
//
// The harness authorizes with AWS_IAM, so the SDK client signs the exec request
// (InvokeAgentRuntimeCommand) with this Lambda's execution-role credentials.
const agentCore = new BedrockAgentCoreClient({ region: REGION });

interface PrepareInput {
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

interface PrepareOutput {
  // The prompt to send to the native invokeHarness task — annotated with a
  // <github_access> block for GitHub runs, unchanged otherwise.
  effectivePrompt: string;
  // Git-auth exec results, surfaced for debugging (also written to the log stream).
  gitAuth?: { exitCode: number; stdout: string; stderr: string };
}

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Logging is best-effort — never fail the run because a log write failed.
  }
}

// Runs a shell command in the harness's runtime session via the harness-exec
// API (InvokeAgentRuntimeCommand → POST /runtimes/{harnessArn}/commands), keyed
// by the same runtimeSessionId the subsequent native invokeHarness task uses so
// both land in the same container. Two things carried over from #52/#53:
//   1. `agentRuntimeArn` here takes the **harness** ARN, not the backing runtime
//      ARN. Calling the runtime ARN directly returns HTTP 400 "managed by a
//      harness and cannot be invoked directly".
//   2. The harness authorizes with AWS_IAM, so this is SigV4-signed via the SDK
//      client above.
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

// Authenticate `git` for HTTPS pushes in the harness session, before the agent's
// turn, by seeding a credential-store file with the GitHub App installation token
// minted by agent-webhook-post-comment.
//
// We deliberately do NOT use `gh` here: the harness image (Amazon Linux 2023)
// ships `git` but not `gh`, and `gh` can't be cleanly installed at exec time
// (tracked in #54). Until then the agent opens PRs with a GitHub compare URL (see
// the <github_access> block below) rather than `gh pr create`.
//
// The token travels once in this exec request body (TLS-encrypted, not visible to
// the model) and is then stored in the session's ~/.git-credentials; the agent's
// subsequent tool calls never receive it, matching the AgUiHandler's
// _prepare_workspace().
async function authenticateGitInHarnessSession(opts: {
  sessionId: string;
  githubToken: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
    // Emit a non-secret confirmation line so the debug log shows the step ran.
    'echo "git credential-store configured for github.com"',
  ].join(' && ');

  return execInHarness({ sessionId, command, timeoutSeconds: 60 });
}

// Step 1 of the (git-only) preparation: authenticate git in the harness session
// and annotate the prompt. Returns the prompt for the native invokeHarness task.
export const handler = async (input: PrepareInput): Promise<PrepareOutput> => {
  const { runId, source, prompt, repo, githubToken, logGroupName, logStreamName } = input;

  if (source !== 'github' || !githubToken) {
    // Jira (or a GitHub run with no token): nothing to authenticate, pass the
    // prompt through unchanged for the native invoke.
    return { effectivePrompt: prompt };
  }

  await log(logGroupName, logStreamName, `[${runId}] authenticating git in harness session`);
  const gitAuth = await authenticateGitInHarnessSession({ sessionId: runId, githubToken });

  // Surface the exec output for debugging: to the run's CloudWatch stream (what
  // the Live Tail link shows) and to this Lambda's own log group.
  console.log(`git-auth exitCode=${gitAuth.exitCode}\nstdout:\n${gitAuth.stdout}\nstderr:\n${gitAuth.stderr}`);
  await log(logGroupName, logStreamName,
    `[${runId}] git auth exitCode=${gitAuth.exitCode}${gitAuth.stdout ? ` stdout=${gitAuth.stdout.trim()}` : ''}${gitAuth.stderr ? ` stderr=${gitAuth.stderr.trim()}` : ''}`);

  if (gitAuth.exitCode !== 0) {
    throw new Error(`Harness exec for git auth exited with code ${gitAuth.exitCode}: ${gitAuth.stderr.trim() || gitAuth.stdout.trim()}`);
  }

  // The exec above authenticated `git` for HTTPS pushes in this session's shell —
  // tell the agent so it clones/pushes with its code-interpreter tool instead of
  // assuming (as it did in #48) that it lacks write access. `gh` is NOT installed
  // (see #54), so the agent opens a PR by printing a GitHub compare URL.
  let effectivePrompt = prompt;
  if (repo) {
    effectivePrompt = [
      prompt,
      '',
      '<github_access>',
      `Your code interpreter's git CLI is already authenticated for the repository ${repo} over HTTPS — git clone/commit/push all work with no token setup needed.`,
      `Clone with: git clone https://github.com/${repo}.git`,
      'Commit and push your branch normally (e.g. git push -u origin <your-branch>).',
      'The `gh` CLI is NOT available. To open a pull request, do NOT try to run `gh`. Instead, after pushing your branch, construct a GitHub "compare" URL and include it in your reply as a clickable link the user can click to open the PR:',
      `  https://github.com/${repo}/compare/<base-branch>...<your-branch>?quick_pull=1&title=<url-encoded-title>&body=<url-encoded-body>`,
      'The base branch is normally `main`. URL-encode the title and body. End your reply with that link so the user can open the PR in one click.',
      '</github_access>',
    ].join('\n');
  }

  return { effectivePrompt, gitAuth };
};
