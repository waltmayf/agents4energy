import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommandCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';
import { mintInstallationToken } from '../_shared/githubAppToken';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CLAUDE_CODE_RUNTIME_ARN = process.env.CLAUDE_CODE_RUNTIME_ARN ?? '';
const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? '';
const GITHUB_APP_PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '';

interface MonitorSpec {
  intervalSeconds: number;
  maxIterations: number;
  checkCommand: string;
  followUpPrompt: string;
}

interface MonitorCheckInput {
  runId: string;
  repo: string | null;
  spec: MonitorSpec;
  iteration: number;
  logGroupName?: string;
  logStreamName?: string;
}

interface MonitorCheckOutput {
  conditionMet: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Logging is best‑effort.
  }
}

async function execInRuntimeSession(opts: { sessionId: string; command: string; timeoutSeconds: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sessionId, command, timeoutSeconds } = opts;
  if (!CLAUDE_CODE_RUNTIME_ARN) throw new Error('CLAUDE_CODE_RUNTIME_ARN not configured');
  const response = await new BedrockAgentCoreClient({ region: REGION }).send(new InvokeAgentRuntimeCommandCommand({
    agentRuntimeArn: CLAUDE_CODE_RUNTIME_ARN,
    runtimeSessionId: sessionId,
    contentType: 'application/json',
    accept: 'application/json',
    body: { command, timeout: timeoutSeconds },
  }));
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  for await (const event of response.stream ?? []) {
    if (event.validationException || event.accessDeniedException || event.resourceNotFoundException || event.throttlingException || event.serviceQuotaExceededException || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.accessDeniedException ?? event.resourceNotFoundException ?? event.throttlingException ?? event.serviceQuotaExceededException ?? event.internalServerException ?? event.runtimeClientError;
      throw new Error(`Monitor‑check exec stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    }
    const chunk = event.chunk;
    if (chunk?.contentDelta?.stdout) stdout += chunk.contentDelta.stdout;
    if (chunk?.contentDelta?.stderr) stderr += chunk.contentDelta.stderr;
    if (typeof chunk?.contentStop?.exitCode === 'number') exitCode = chunk.contentStop.exitCode;
  }
  return { exitCode: exitCode ?? -1, stdout, stderr };
}

// Re-mints a fresh (seconds-old) GitHub App installation token and rewrites
// the runtime session's ~/.git-credentials before the check command runs —
// the monitor-loop analog of agent-webhook-invoke-claude's mintFreshGithubToken
// (issue #444/#445). Without this, a checkCommand that pushes (or the agent's
// own follow-up push after a passing check) fails with a stale-token 401 once
// the ~1h token minted at PostInitialComment has expired mid-wait (issue #467).
//
// Best-effort: if repo/env isn't available or minting fails, log and continue
// — the checkCommand still runs against whatever credentials are already in
// the session, same as before this fix, rather than failing the whole check.
async function refreshGitCredentials(
  sessionId: string,
  repo: string | null,
  log: (msg: string) => void,
): Promise<void> {
  if (!repo || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_SECRET_ARN) return;
  try {
    const { token } = await mintInstallationToken(repo, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN);
    const command = [
      'git config --global credential.helper store',
      `printf 'https://x-access-token:%s@github.com\\n' ${JSON.stringify(token)} > "$HOME/.git-credentials"`,
      'chmod 600 "$HOME/.git-credentials"',
    ].join('\n');
    await execInRuntimeSession({ sessionId, command, timeoutSeconds: 30 });
  } catch (err) {
    log(`failed to refresh git credentials before monitor check; continuing with existing credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const handler = async (input: MonitorCheckInput): Promise<MonitorCheckOutput> => {
  const { runId, repo, spec, iteration, logGroupName, logStreamName } = input;
  await log(logGroupName, logStreamName, `[${runId}] monitor check iteration ${iteration} running: ${spec.checkCommand}`);

  // Refresh git credentials before executing the user-provided check command.
  await refreshGitCredentials(runId, repo, (msg) => {
    void log(logGroupName, logStreamName, `[${runId}] ${msg}`);
  });

  const result = await execInRuntimeSession({ sessionId: runId, command: spec.checkCommand, timeoutSeconds: 90 });
  const conditionMet = result.exitCode === 0;
  console.log(`monitor check iteration=${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  await log(logGroupName, logStreamName,
    `[${runId}] monitor check iteration ${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}` +
    `${result.stdout ? ` stdout=${result.stdout.trim().slice(0, 500)}` : ''}` +
    `${result.stderr ? ` stderr=${result.stderr.trim().slice(0, 500)}` : ''}`);
  return { conditionMet, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};
