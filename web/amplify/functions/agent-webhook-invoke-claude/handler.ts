import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { appendLog } from '../_shared/liveTail';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CLAUDE_CODE_RUNTIME_ARN = process.env.CLAUDE_CODE_RUNTIME_ARN ?? '';

// The Claude Code runtime authorizes with AWS_IAM (the default when a runtime
// has no CUSTOM_JWT authorizer), so the SDK signs InvokeAgentRuntime with this
// Lambda's execution-role credentials.
const agentCore = new BedrockAgentCoreClient({ region: REGION });

// Mirrors the git-auth step's input — the state machine passes the same fields
// (plus the token minted by PostInitialComment) to whichever agent branch runs.
// `taskToken` is added by the InvokeClaude task (WAIT_FOR_TASK_TOKEN, issue
// #175): we forward it to the runtime, which resumes the paused SFN task via
// SendTaskSuccess/SendTaskFailure when the (possibly hours-long) job finishes.
interface InvokeClaudeInput {
  taskToken: string;
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

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Best-effort — never fail the run because a log write failed.
  }
}

// Kicks off the Claude Code runtime and returns immediately. Because the
// InvokeClaude task uses WAIT_FOR_TASK_TOKEN, this Lambda's return value is
// IGNORED for the task result — the runtime supplies the real result later by
// calling SendTaskSuccess with the task token. So we only need to confirm the
// runtime accepted the job (fast 200 ack) and then get out of the way; the SFN
// task stays paused until the runtime reports back (or the task times out).
export const handler = async (input: InvokeClaudeInput): Promise<{ started: true }> => {
  const { taskToken, runId, prompt, repo, issueNumber, githubToken, agentsSystemPrompt, logGroupName, logStreamName } = input;

  if (!CLAUDE_CODE_RUNTIME_ARN) {
    throw new Error('CLAUDE_CODE_RUNTIME_ARN not configured — the ClaudeCode runtime is not deployed on this branch.');
  }

  await log(logGroupName, logStreamName, `[${runId}] starting Claude Code runtime (repo=${repo ?? '(none)'} issue=${issueNumber ?? '(none)'})`);

  // The runtime's server.js reads these fields (see agent/default/app/ClaudeCode/server.js).
  // When `taskToken` is present the runtime runs the job in the background and
  // resumes this paused task itself; the HTTP ack below is just "job accepted".
  const payload = {
    taskToken,
    prompt,
    repo: repo ?? undefined,
    issueNumber: issueNumber ?? undefined,
    githubToken: githubToken ?? undefined,
    // AGENTS.md-derived system prompt (fetched by PostInitialComment), passed
    // through so the runtime can append it to Claude Code's system prompt.
    systemAppend: agentsSystemPrompt ?? undefined,
  };

  const response = await agentCore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CLAUDE_CODE_RUNTIME_ARN,
    // Same session id as the rest of the run, so a follow-up @agentcore-claude
    // comment on the same issue reuses the runtime's session storage / clone.
    runtimeSessionId: runId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));

  // The runtime replies with a quick JSON ack (`{ started: true }`) once it has
  // spawned the background job. Collect it to confirm acceptance; a non-2xx ack
  // means the runtime never took ownership of the token, so throw — the task's
  // own failure/catch handles it (the runtime hasn't and won't call SendTask*).
  const raw = response.response ? await response.response.transformToString() : '';

  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`Claude Code runtime failed to accept the job (HTTP ${response.statusCode}): ${raw.slice(0, 2000)}`);
  }

  await log(logGroupName, logStreamName, `[${runId}] Claude Code runtime accepted the job; awaiting task-token callback`);

  // Return value is ignored by the callback pattern — the runtime resumes the
  // paused task via SendTaskSuccess/SendTaskFailure. Return a small ack for logs.
  return { started: true };
};
