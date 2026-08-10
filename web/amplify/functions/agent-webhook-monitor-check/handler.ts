import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommandCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CLAUDE_CODE_RUNTIME_ARN = process.env.CLAUDE_CODE_RUNTIME_ARN ?? '';

// The monitor check runs a shell command in the SAME ClaudeCode runtime session
// as the original @agentcore-claude run (keyed by runId), so the check sees the
// same /mnt/workspace and repo checkout the agent left behind. Unlike the
// harness (which rejects a direct runtime-ARN invoke — see
// agent-webhook-invoke-agent/handler.ts), the ClaudeCode runtime is a plain
// AgentCore runtime, so InvokeAgentRuntimeCommand against its ARN is the correct
// exec path. Authorized with AWS_IAM (SigV4 via this Lambda's execution role;
// grant added in backend.ts).
const agentCore = new BedrockAgentCoreClient({ region: REGION });

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
    // Logging is best-effort — never fail the check because a log write failed.
  }
}

// Runs the monitor's checkCommand in the runtime session and drains the exec
// stream (same contentDelta/contentStop shape as agent-webhook-invoke-agent's
// execInHarness). conditionMet is the shell exit-code contract: 0 → met.
async function execInRuntimeSession(opts: {
  sessionId: string;
  command: string;
  timeoutSeconds: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sessionId, command, timeoutSeconds } = opts;

  if (!CLAUDE_CODE_RUNTIME_ARN) throw new Error('CLAUDE_CODE_RUNTIME_ARN not configured');

  const response = await agentCore.send(new InvokeAgentRuntimeCommandCommand({
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
    if (event.validationException || event.accessDeniedException || event.resourceNotFoundException
      || event.throttlingException || event.serviceQuotaExceededException
      || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.accessDeniedException ?? event.resourceNotFoundException
        ?? event.throttlingException ?? event.serviceQuotaExceededException
        ?? event.internalServerException ?? event.runtimeClientError;
      throw new Error(`Monitor-check exec stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    }
    const chunk = event.chunk;
    if (chunk?.contentDelta?.stdout) stdout += chunk.contentDelta.stdout;
    if (chunk?.contentDelta?.stderr) stderr += chunk.contentDelta.stderr;
    if (typeof chunk?.contentStop?.exitCode === 'number') exitCode = chunk.contentStop.exitCode;
  }

  return { exitCode: exitCode ?? -1, stdout, stderr };
}

export const handler = async (input: MonitorCheckInput): Promise<MonitorCheckOutput> => {
  const { runId, spec, iteration, logGroupName, logStreamName } = input;

  await log(logGroupName, logStreamName,
    `[${runId}] monitor check iteration ${iteration} running: ${spec.checkCommand}`);

  // Bound the exec below the Lambda's own 120s timeout so a hung check surfaces
  // as a non-zero result rather than a Lambda timeout the loop can't interpret.
  const result = await execInRuntimeSession({
    sessionId: runId,
    command: spec.checkCommand,
    timeoutSeconds: 90,
  });

  const conditionMet = result.exitCode === 0;

  // Surface the check output for debugging: to the run's CloudWatch stream (the
  // Live Tail link the initial comment points at) and this Lambda's log group.
  console.log(`monitor check iteration=${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  await log(logGroupName, logStreamName,
    `[${runId}] monitor check iteration ${iteration} exitCode=${result.exitCode} conditionMet=${conditionMet}`
    + `${result.stdout ? ` stdout=${result.stdout.trim().slice(0, 500)}` : ''}`
    + `${result.stderr ? ` stderr=${result.stderr.trim().slice(0, 500)}` : ''}`);

  return { conditionMet, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};
