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
// (and gh) credentials *before* the agent turn, and hand the annotated prompt
// back to the state machine. The command's stdout/stderr are written to the
// run's CloudWatch Logs stream so a failed clone/push is debuggable there.
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
  // Issue title/body + all prior comments, fetched by agent-webhook-post-comment
  // (GitHub only) so the agent sees the full thread, not just the triggering
  // comment's text after the mention.
  issueContext?: string | null;
  logGroupName?: string;
  logStreamName?: string;
}

interface PrepareOutput {
  // The prompt to send to the native invokeHarness task — annotated with an
  // <issue_context> block and (for GitHub runs) a <github_access> block.
  effectivePrompt: string;
  // Git/gh-auth exec results, surfaced for debugging (also written to the log stream).
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

// Pinned so a `gh` release doesn't change behavior under us; bump deliberately.
const GH_VERSION = '2.96.0';

// Authenticate `git` and `gh` for HTTPS pushes / PR creation in the harness
// session, before the agent's turn, using the GitHub App installation token
// minted by agent-webhook-post-comment.
//
// `gh` is not present in the harness image (Amazon Linux 2023) and isn't in
// its dnf repos, so it's installed here on every run rather than baked into
// the image — there's no Dockerfile for MyHarness's runtime to bake it into
// (it's a managed AgentCore harness image, unlike AgUiHandler's
// agent/handler/Dockerfile). Verified in a sandbox with the same AL2023 image
// (#54): `dnf install gh` has no match, and extracting the official RPM needs
// `cpio`/relocatable-package support the image also lacks. The approach that
// works: download the official pre-built tarball for the container's
// architecture and extract it with Python's stdlib `tarfile` module — `tar`
// itself isn't installed either, but `python3` is, so this avoids pulling in
// another package via dnf. Cost is one ~13MB download (~0.5s on a fast link)
// plus a fast local extract; the `command -v gh` guard skips all of this if
// the underlying container happens to be reused across runs.
//
// Both tokens (git's and gh's) travel once in this exec request body
// (TLS-encrypted, never visible to the model) and are then stored in the
// session's ~/.git-credentials / gh's config; the agent's subsequent tool
// calls never receive them, matching the AgUiHandler's _prepare_workspace().
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
    'if ! command -v gh >/dev/null 2>&1; then',
    '  GH_ARCH=$(case "$(uname -m)" in aarch64) echo arm64 ;; x86_64) echo amd64 ;; *) uname -m ;; esac)',
    `  curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_\${GH_ARCH}.tar.gz"`,
    `  python3 -c "import tarfile; tarfile.open('/tmp/gh.tar.gz').extractall('/tmp')"`,
    `  mv "/tmp/gh_${GH_VERSION}_linux_\${GH_ARCH}/bin/gh" /usr/local/bin/gh`,
    '  chmod +x /usr/local/bin/gh',
    `  rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_\${GH_ARCH}"`,
    'fi',
    `printf '%s' ${JSON.stringify(githubToken)} | gh auth login --hostname github.com --with-token`,
    'gh auth setup-git',
    // Emit a non-secret confirmation line so the debug log shows the step ran.
    'echo "git/gh credential setup configured for github.com"',
  ].join('\n');

  return execInHarness({ sessionId, command, timeoutSeconds: 90 });
}

// Step 1 of the (git-only) preparation: authenticate git/gh in the harness
// session and annotate the prompt. Returns the prompt for the native
// invokeHarness task.
export const handler = async (input: PrepareInput): Promise<PrepareOutput> => {
  const { runId, source, prompt, repo, issueContext, githubToken, logGroupName, logStreamName } = input;

  let effectivePrompt = prompt;

  // Prepend the full issue thread (title/body/all comments) so the agent has
  // the same context a human reading the issue would, not just the text after
  // the trigger mention in whichever comment invoked this run.
  if (issueContext) {
    effectivePrompt = [
      '<issue_context>',
      issueContext,
      '</issue_context>',
      '',
      effectivePrompt,
    ].join('\n');
  }

  if (source !== 'github' || !githubToken) {
    // Jira (or a GitHub run with no token): nothing to authenticate, pass the
    // prompt through unchanged for the native invoke.
    return { effectivePrompt };
  }

  await log(logGroupName, logStreamName, `[${runId}] authenticating git/gh in harness session`);
  const gitAuth = await authenticateGitInHarnessSession({ sessionId: runId, githubToken });

  // Surface the exec output for debugging: to the run's CloudWatch stream (what
  // the Live Tail link shows) and to this Lambda's own log group.
  console.log(`git/gh-auth exitCode=${gitAuth.exitCode}\nstdout:\n${gitAuth.stdout}\nstderr:\n${gitAuth.stderr}`);
  await log(logGroupName, logStreamName,
    `[${runId}] git/gh auth exitCode=${gitAuth.exitCode}${gitAuth.stdout ? ` stdout=${gitAuth.stdout.trim()}` : ''}${gitAuth.stderr ? ` stderr=${gitAuth.stderr.trim()}` : ''}`);

  if (gitAuth.exitCode !== 0) {
    throw new Error(`Harness exec for git/gh auth exited with code ${gitAuth.exitCode}: ${gitAuth.stderr.trim() || gitAuth.stdout.trim()}`);
  }

  // The exec above authenticated both `git` and `gh` for the target repo in
  // this session's shell — tell the agent so it clones/pushes/opens PRs with
  // its code interpreter tool instead of assuming (as it did in #48) that it
  // lacks write access.
  if (repo) {
    effectivePrompt = [
      effectivePrompt,
      '',
      '<github_access>',
      `Your code interpreter's git and gh CLIs are already authenticated for the repository ${repo} — git clone/commit/push and gh pr create all work with no token setup needed.`,
      `Clone with: git clone https://github.com/${repo}.git`,
      'Commit and push your branch normally (e.g. git push -u origin <your-branch>).',
      `Open the pull request directly with: gh pr create --repo ${repo} --base main --head <your-branch> --title "<title>" --body "<body>"`,
      'Include the resulting PR URL (printed by `gh pr create`) in your reply.',
      '</github_access>',
    ].join('\n');
  }

  return { effectivePrompt, gitAuth };
};
