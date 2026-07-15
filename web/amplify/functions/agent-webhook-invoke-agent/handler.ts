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
  agentsSystemPrompt?: string | null;
  logGroupName?: string;
  logStreamName?: string;
}

interface GithubIssueDetails {
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  labels: Array<{ name: string } | string>;
  pull_request?: { url: string };
}

interface GithubComment {
  user: { login: string };
  body: string;
  created_at: string;
}

interface GithubPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GithubPullDetails {
  base: { ref: string };
  head: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface PrepareOutput {
  // The prompt to send to the native invokeHarness task — annotated with a
  // <github_context> block (issue/PR state) and a <github_access> block for
  // GitHub runs, unchanged otherwise.
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

// Node.js is needed for the agent to do development work (install deps, run
// builds/tests). Like `gh`, it isn't in the harness image (Amazon Linux 2023)
// and is installed on every run from the official pre-built tarball, extracted
// with Python's stdlib `tarfile` (`tar` isn't present in the image either). The
// `.tar.gz` build is used rather than the default `.tar.xz` so extraction never
// depends on the container having liblzma. Pinned to the current LTS; bump
// deliberately.
const NODE_VERSION = '22.17.0';

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
    // Node.js — needed for the agent's development work (npm/pnpm install, build,
    // test). Node's arch names are arm64/x64; the tarball unpacks to a versioned
    // dir whose bin/ is symlinked onto PATH so `node`/`npm`/`npx` resolve.
    'if ! command -v node >/dev/null 2>&1; then',
    '  NODE_ARCH=$(case "$(uname -m)" in aarch64) echo arm64 ;; x86_64) echo x64 ;; *) uname -m ;; esac)',
    `  curl -fsSL -o /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-\${NODE_ARCH}.tar.gz"`,
    `  python3 -c "import tarfile; tarfile.open('/tmp/node.tar.gz').extractall('/tmp')"`,
    `  rm -rf "/usr/local/lib/node-v${NODE_VERSION}"`,
    `  mv "/tmp/node-v${NODE_VERSION}-linux-\${NODE_ARCH}" "/usr/local/lib/node-v${NODE_VERSION}"`,
    `  ln -sf "/usr/local/lib/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node`,
    `  ln -sf "/usr/local/lib/node-v${NODE_VERSION}/bin/npm" /usr/local/bin/npm`,
    `  ln -sf "/usr/local/lib/node-v${NODE_VERSION}/bin/npx" /usr/local/bin/npx`,
    '  rm -f /tmp/node.tar.gz',
    'fi',
    // Install pnpm if missing
    "if ! command -v pnpm >/dev/null 2>&1; then",
    "  npm i -g pnpm@latest",
    "fi",
    `printf '%s' ${JSON.stringify(githubToken)} | gh auth login --hostname github.com --with-token`,
    'gh auth setup-git',
    // Emit a non-secret confirmation line so the debug log shows the step ran.
    'echo "git/gh credential setup configured for github.com; node $(node --version) available"',
  ].join('\n');

  return execInHarness({ sessionId, command, timeoutSeconds: 90 });
}

async function githubApiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed (HTTP ${res.status}): ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Truncation caps so a long-running thread or huge PR can't blow past the
// harness invoke's own input limits or bury the actual request in noise.
const MAX_COMMENTS = 20;
const MAX_COMMENT_CHARS = 2000;
const MAX_FILES_LISTED = 50;

function labelNames(labels: GithubIssueDetails['labels']): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name));
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
}

// Fetches the issue/PR's full current state (issue #73) — labels, the entire
// comment thread, and (for PRs) the changed-files summary — so the agent sees
// the same context a human triager would, not just the title+body snapshot
// the webhook payload happened to carry. Fetched fresh here (rather than
// trusting the webhook payload) so label/comment/PR runs all get identical,
// up-to-date context regardless of which webhook event triggered the run.
async function buildGithubContextBlock(repo: string, issueNumber: number, token: string): Promise<string> {
  const issue = await githubApiGet<GithubIssueDetails>(`/repos/${repo}/issues/${issueNumber}`, token);
  const isPr = Boolean(issue.pull_request);

  const comments = await githubApiGet<GithubComment[]>(
    `/repos/${repo}/issues/${issueNumber}/comments?per_page=${MAX_COMMENTS}`,
    token,
  );

  const lines: string[] = [
    '<github_context>',
    `Repository: ${repo}`,
    `${isPr ? 'Pull request' : 'Issue'} #${issueNumber}: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: @${issue.user.login}`,
    `Labels: ${labelNames(issue.labels).join(', ') || '(none)'}`,
    '',
    'Description:',
    truncate(issue.body ?? '(no description)', MAX_COMMENT_CHARS),
  ];

  if (isPr) {
    const pr = await githubApiGet<GithubPullDetails>(`/repos/${repo}/pulls/${issueNumber}`, token);
    const files = await githubApiGet<GithubPullFile[]>(
      `/repos/${repo}/pulls/${issueNumber}/files?per_page=${MAX_FILES_LISTED}`,
      token,
    );
    lines.push(
      '',
      `Base branch: ${pr.base.ref}  Head branch: ${pr.head.ref}`,
      `Changed files: ${pr.changed_files} (+${pr.additions} / -${pr.deletions})`,
      ...files.map((f) => `  ${f.status}: ${f.filename} (+${f.additions} / -${f.deletions})`),
    );
  }

  if (comments.length > 0) {
    lines.push('', `Comment thread (${comments.length}${comments.length === MAX_COMMENTS ? '+' : ''}):`);
    for (const c of comments) {
      lines.push(`--- @${c.user.login} at ${c.created_at} ---`, truncate(c.body, MAX_COMMENT_CHARS));
    }
  }

  lines.push('</github_context>');
  return lines.join('\n');
}

// Step 1 of the (git-only) preparation: authenticate git/gh in the harness
// session and annotate the prompt. Returns the prompt for the native
// invokeHarness task.
export const handler = async (input: PrepareInput): Promise<PrepareOutput> => {
  const { runId, source, prompt, repo, issueNumber, githubToken, agentsSystemPrompt, logGroupName, logStreamName } = input;
  // Wrapped in <agents_md> (matching <github_context>/<github_access> below) so
  // the chat UI can split it out of the first user turn and render it with
  // assistant-message Markdown styling instead of as a plain-text wall (#120).
  const promptWithAgentsMd = agentsSystemPrompt
    ? [`<agents_md>\n${agentsSystemPrompt}\n</agents_md>`, prompt].join('\n\n')
    : prompt;

  if (source !== 'github' || !githubToken) {
    // Jira (or a GitHub run with no token): nothing to authenticate, pass the
    // prompt through unchanged for the native invoke.
    return { effectivePrompt: promptWithAgentsMd };
  }

  // Pull the full current issue/PR context (issue #73) before the agent's turn —
  // labels, the full comment thread, and PR file/diff stats — so the initial
  // message carries everything a human triager would see, not just the
  // title+body the webhook payload happened to include.
  let effectivePromptWithContext = promptWithAgentsMd;
  if (repo && issueNumber !== null) {
    try {
      const contextBlock = await buildGithubContextBlock(repo, issueNumber, githubToken);
      effectivePromptWithContext = [promptWithAgentsMd, '', contextBlock].join('\n');
    } catch (err) {
      // Missing context shouldn't block the run — the agent still gets the
      // title+body prompt the receiver already built.
      console.warn(`Could not fetch GitHub context for ${repo}#${issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
      await log(logGroupName, logStreamName,
        `[${runId}] warning: could not fetch GitHub context: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  let effectivePrompt = effectivePromptWithContext;
  if (repo) {
    effectivePrompt = [
      effectivePromptWithContext,
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
