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

// Refresh the git credentials stored in ~/.git-credentials for the runtime session.
async function refreshGitCredentials(sessionId: string): Promise<void> {
  // Determine the repo URL from the checked‑out workspace.
  const repoInfo = await execInRuntimeSession({ sessionId, command: 'git config --get remote.origin.url', timeoutSeconds: 10 });
  const repoUrl = repoInfo.stdout.trim();
  const match = repoUrl.match(/^https:\/\/github\.com\/(.+?)\.git$/);
  if (!match) return; // cannot determine repo, skip refresh
  const repo = match[1];
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY_SECRET_ARN) return;
  const { token } = await mintInstallationToken(repo, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_SECRET_ARN);
  // Write fresh credentials.
  const command = [
    'git config --global credential.helper store',
    `printf 'https://x-access-token:%s@github.com\\n' ${JSON.stringify(token)} > "$HOME/.git-credentials"`,
    'chmod 600 "$HOME/.git-credentials"',
  ].join('\n');
  await execInRuntimeSession({ sessionId, command, timeoutSeconds: 30 });
}

export const handler = async (input: MonitorCheckInput): Promise<MonitorCheckOutput> => {
  const { runId, spec, iteration, logGroupName, logStreamName } = input;
  await log(logGroupName, logStreamName, `[${runId}] monitor check iteration ${iteration} running: ${spec.checkCommand}`);

  // Refresh git credentials before executing the user‑provided check command.
  await refreshGitCredentials(runId);

  const result = await execInRuntimeSession({ sessionId: runId, command: spec.checkCommand, timeoutSeconds: 90 });
  const conditionMet = result.exitCode === 0;
  console.log(`monitor check iteration=${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  await log(logGroupName, logStreamName,
    `[${runId}] monitor check iteration ${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}` +
    `${result.stdout ? ` stdout=${result.stdout.trim().slice(0, 500)}` : ''}` +
    `${result.stderr ? ` stderr=${result.stderr.trim().slice(0, 500)}` : ''}`);
  return { conditionMet, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};
