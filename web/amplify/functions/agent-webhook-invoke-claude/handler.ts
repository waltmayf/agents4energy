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
interface InvokeClaudeInput {
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

// Same shape the native invokeHarness task produces, so the shared
// PostFinalComment step reads $.agentResult.Output.Message.Content[0].Text
// identically for both the harness and the Claude Code runtime.
interface AgentResult {
  Output: { Message: { Role: 'assistant'; Content: Array<{ Text: string }> } };
}

async function log(groupName: string | undefined, streamName: string | undefined, message: string): Promise<void> {
  if (!groupName || !streamName) return;
  try {
    await appendLog(groupName, streamName, message);
  } catch {
    // Best-effort — never fail the run because a log write failed.
  }
}

export const handler = async (input: InvokeClaudeInput): Promise<AgentResult> => {
  const { runId, prompt, repo, issueNumber, githubToken, agentsSystemPrompt, logGroupName, logStreamName } = input;

  if (!CLAUDE_CODE_RUNTIME_ARN) {
    throw new Error('CLAUDE_CODE_RUNTIME_ARN not configured — the ClaudeCode runtime is not deployed on this branch.');
  }

  await log(logGroupName, logStreamName, `[${runId}] invoking Claude Code runtime (repo=${repo ?? '(none)'} issue=${issueNumber ?? '(none)'})`);

  // The runtime's server.js reads these fields (see agent/default/app/ClaudeCode/server.js).
  const payload = {
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

  // InvokeAgentRuntime returns the runtime's HTTP response body as a streaming
  // blob; our server.js replies with a single JSON object (not SSE), so collect
  // it fully and parse.
  const raw = response.response ? await response.response.transformToString() : '';

  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`Claude Code runtime returned HTTP ${response.statusCode}: ${raw.slice(0, 2000)}`);
  }

  let resultText: string;
  try {
    const parsed = JSON.parse(raw) as { result?: string; error?: string };
    if (parsed.error) throw new Error(`Claude Code runtime error: ${parsed.error}`);
    resultText = parsed.result ?? raw;
  } catch (err) {
    // If the body wasn't the JSON we expected, surface it rather than crashing
    // the state — but a thrown runtime error above should propagate.
    if (err instanceof Error && err.message.startsWith('Claude Code runtime error:')) throw err;
    resultText = raw;
  }

  await log(logGroupName, logStreamName, `[${runId}] Claude Code runtime finished (${resultText.length} chars)`);

  return {
    Output: { Message: { Role: 'assistant', Content: [{ Text: resultText }] } },
  };
};
