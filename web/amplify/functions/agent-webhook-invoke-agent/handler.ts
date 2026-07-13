import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const HARNESS_ARN = process.env.HARNESS_ARN ?? '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
const SERVICE_ACCOUNT_USERNAME = process.env.SERVICE_ACCOUNT_USERNAME ?? '';
const SERVICE_ACCOUNT_SSM_PATH = process.env.SERVICE_ACCOUNT_SSM_PATH ?? '';

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

// The AgentCore control-plane host both the harness-invoke and harness-exec
// APIs live on, derived from the harness ARN's region field.
function agentCoreHost(): string {
  const region = HARNESS_ARN.split(':')[3] || REGION;
  return `https://bedrock-agentcore.${region}.amazonaws.com`;
}

// Cache the access token across warm invocations (~1 hour lifetime).
let cachedAccessToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  const passwordParam = await ssm.send(new GetParameterCommand({
    Name: SERVICE_ACCOUNT_SSM_PATH,
    WithDecryption: true,
  }));
  const password = passwordParam.Parameter?.Value;
  if (!password) throw new Error('Service account password not found in SSM');

  const authRes = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: {
      USERNAME: SERVICE_ACCOUNT_USERNAME,
      PASSWORD: password,
    },
  }));

  const token = authRes.AuthenticationResult?.AccessToken;
  if (!token) throw new Error('Failed to obtain Cognito access token for service account');

  cachedAccessToken = token;
  return token;
}

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
// API (`POST /runtimes/{harnessArn}/commands`), keyed by the same
// runtimeSessionId the subsequent InvokeHarness call uses so both land in the
// same container. Two things this differs from the (never-working) approach in
// #52, discovered while verifying #53:
//   1. The exec endpoint takes the **harness** ARN in its path, not the
//      backing runtime ARN. Calling the runtime ARN directly returns HTTP 400
//      "managed by a harness and cannot be invoked directly".
//   2. The harness's runtime is CUSTOM_JWT-authorized, so exec must use the
//      same Cognito Bearer token as /harnesses/invoke — a SigV4 call (what the
//      SDK's InvokeAgentRuntimeCommand sent) is rejected with HTTP 403
//      "Authorization method mismatch".
// The response is an AWS binary event stream of `contentDelta` (stdout/stderr)
// and a final `contentStop` (exitCode) frames — decoded below for diagnostics.
async function execInHarness(opts: {
  sessionId: string;
  command: string;
  timeoutSeconds?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sessionId, command, timeoutSeconds = 120 } = opts;

  if (!HARNESS_ARN) throw new Error('HARNESS_ARN not configured');

  const accessToken = await getAccessToken();
  const url = `${agentCoreHost()}/runtimes/${encodeURIComponent(HARNESS_ARN)}/commands`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    },
    body: JSON.stringify({ command, timeout: timeoutSeconds }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) cachedAccessToken = null;
    throw new Error(`Harness exec HTTP ${response.status}: ${text}`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;

  await decodeEventStream(response, (headers, payload, payloadBytes) => {
    if (headers[':message-type'] === 'exception' || headers[':event-type'] === 'exception') {
      const message = (payload?.message as string | undefined) ?? payloadBytes.toString('utf8');
      throw new Error(`Harness exec stream exception (${headers[':exception-type'] ?? 'unknown'}): ${message}`);
    }
    // Exec frames are `:event-type: chunk` carrying contentStart/Delta/Stop.
    const delta = payload?.contentDelta as Record<string, unknown> | undefined;
    if (delta?.stdout) stdout += delta.stdout as string;
    if (delta?.stderr) stderr += delta.stderr as string;
    const stop = payload?.contentStop as Record<string, unknown> | undefined;
    if (stop && typeof stop.exitCode === 'number') exitCode = stop.exitCode;
  });

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
  // and, being the body of a JSON POST, is never echoed to the model.
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

// Decode an AWS binary event stream (the framing both /harnesses/invoke and
// the harness-exec /commands endpoints return), invoking `onFrame` for each
// complete frame. Identical framing logic to invoke-agent + scripts/invoke.ts.
async function decodeEventStream(
  response: Response,
  onFrame: (headers: Record<string, string>, payload: Record<string, unknown> | null, payloadBytes: Buffer) => void,
): Promise<void> {
  let raw = Buffer.alloc(0);

  for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
    raw = Buffer.concat([raw, chunk]);

    while (raw.length >= 12) {
      const totalLen = raw.readUInt32BE(0);
      if (raw.length < totalLen) break;

      const headersLen = raw.readUInt32BE(4);
      let pos = 12;
      const headersEnd = pos + headersLen;
      const headers: Record<string, string> = {};

      while (pos < headersEnd) {
        const nameLen = raw[pos++];
        const name = raw.subarray(pos, pos + nameLen).toString('utf8');
        pos += nameLen;
        pos++; // value type byte
        const valLen = raw.readUInt16BE(pos); pos += 2;
        headers[name] = raw.subarray(pos, pos + valLen).toString('utf8');
        pos += valLen;
      }

      const payloadBytes = raw.subarray(12 + headersLen, totalLen - 4);
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(payloadBytes.toString('utf8')); } catch { /* empty frame */ }

      onFrame(headers, payload, payloadBytes);

      raw = raw.subarray(totalLen);
    }
  }
}

// Invoke the AgentCore Harness over its HTTP `/harnesses/invoke` endpoint,
// authenticated with a Cognito service-account JWT — the same path the
// browser-initiated invoke-agent Lambda uses (web/amplify/functions/invoke-agent/handler.ts).
// The harness authorizes with CUSTOM_JWT (not SigV4), so a raw
// InvokeAgentRuntimeCommand against the runtime fails with an
// "Authorization method mismatch" error; the JWT path is the supported one.
// The response is an AWS binary event stream — decode contentBlockDelta frames
// into the full text.
async function invokeHarness(opts: {
  sessionId: string;
  prompt: string;
}): Promise<string> {
  const { sessionId, prompt } = opts;

  if (!HARNESS_ARN) throw new Error('HARNESS_ARN not configured');

  const accessToken = await getAccessToken();

  const encodedArn = encodeURIComponent(HARNESS_ARN);
  const url = `${agentCoreHost()}/harnesses/invoke?harnessArn=${encodedArn}`;

  const body: Record<string, unknown> = {
    runtimeSessionId: sessionId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    // Reset token cache on auth errors so the next invocation re-authenticates.
    if (response.status === 401 || response.status === 403) cachedAccessToken = null;
    throw new Error(`Harness HTTP ${response.status}: ${text}`);
  }

  const chunks: string[] = [];

  await decodeEventStream(response, (headers, payload, payloadBytes) => {
    // The stream frames errors as `:message-type: exception` (e.g. a bad
    // model id surfaces here as a ValidationException). Surface it instead
    // of silently returning "(no response)" — a swallowed exception frame is
    // what made an invalid harness model look like an empty agent reply.
    if (headers[':message-type'] === 'exception' || headers[':event-type'] === 'exception') {
      const message = (payload?.message as string | undefined) ?? payloadBytes.toString('utf8');
      throw new Error(`Harness stream exception (${headers[':exception-type'] ?? 'unknown'}): ${message}`);
    }

    if (headers[':event-type'] === 'contentBlockDelta') {
      const text = (payload?.delta as Record<string, unknown> | undefined)?.text as string | undefined;
      if (text) chunks.push(text);
    }
  });

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
