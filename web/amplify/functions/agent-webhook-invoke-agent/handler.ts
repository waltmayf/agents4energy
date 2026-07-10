import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const AGUI_RUNTIME_ARN = process.env.AGUI_RUNTIME_ARN!;

const client = new BedrockAgentCoreClient({ region: REGION });

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

export const handler = async (input: InvokeAgentInput): Promise<InvokeAgentOutput> => {
  const { runId, source, prompt, repo, githubToken, logGroupName, logStreamName } = input;

  await log(logGroupName, logStreamName, `[${runId}] invoking agent (source=${source})`);

  // The runtime returns a single blocking response in sync mode (see agent/handler/agent.py
  // — no AG-UI events are published here), so emit a heartbeat every 20s while waiting. This
  // is the best "live" signal available without switching agent.py to stream step-by-step
  // events into this run's log stream — see docs/webhook-stepfunction-integration.md.
  const heartbeat = setInterval(() => {
    void log(logGroupName, logStreamName, `[${runId}] still running…`);
  }, 20_000);

  try {
    const payload: Record<string, unknown> = { sessionId: runId, prompt, sync: true };
    if (source === 'github' && githubToken && repo) {
      payload.githubToken = githubToken;
      payload.githubRepo = repo;
      payload.githubBranch = 'main';
    }

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGUI_RUNTIME_ARN,
      qualifier: 'DEFAULT',
      runtimeSessionId: runId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });

    const result = await client.send(command);
    const bodyBytes = result.response ? await result.response.transformToByteArray() : new Uint8Array();
    const bodyText = new TextDecoder().decode(bodyBytes);
    const parsed = bodyText ? JSON.parse(bodyText) as { response?: string; error?: string } : {};
    const response = parsed.response ?? parsed.error ?? '(no response)';

    await log(logGroupName, logStreamName, `[${runId}] agent responded (${response.length} chars)`);
    return { response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(logGroupName, logStreamName, `[${runId}] agent invocation failed: ${message}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
};
