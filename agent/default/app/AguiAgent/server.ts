// AG-UI-native AgentCore Runtime (issue #176).
//
// MyHarness (agent/default/app/MyHarness) and the ClaudeCode runtime
// (agent/default/app/ClaudeCode) both speak Bedrock Converse — the frontend
// has to translate Converse events into AG-UI events itself (see
// web/lib/converse-to-agui.ts). This runtime instead wraps a Strands agent
// with @ag-ui/aws-strands, so it emits AG-UI's RUN_STARTED/TEXT_MESSAGE_*/
// TOOL_CALL_*/RUN_FINISHED events natively over the wire — no translation
// layer needed on a future frontend built against it.
//
// Per docs.aws.amazon.com/bedrock-agentcore/.../runtime-agui.html, AgentCore
// Runtime proxies AG-UI containers on port 8080 at POST /invocations (SSE)
// and GET /ping (health) — the same contract HTTP runtimes use, distinguished
// by the `protocol: AGUI` flag in agentcore.json (see AgentEnvSpec).
//
// This does NOT replace MyHarness — it's an additive, independently invoked
// runtime. See docs/agui-runtime.md.
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { Agent } from '@strands-agents/sdk';
import { StrandsAgent } from '@ag-ui/aws-strands';
import { EventEncoder } from '@ag-ui/encoder';
import { RunAgentInputSchema, type BaseEvent, EventType } from '@ag-ui/core';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { AssistantTurnAccumulator, persistAssistantTurn, persistUserPrompt } from './memory.js';

const PORT = 8080;

// Overridable via env so the runtime's model can be bumped without a code
// change, matching the ClaudeCode runtime's ANTHROPIC_MODEL convention.
const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-5';

const SYSTEM_PROMPT = process.env.AGUI_SYSTEM_PROMPT
  || 'You are a helpful assistant embedded in the agents4energy platform. Be concise and accurate.';

// AgentCore Memory (MyHarnessMemory, shared with MyHarness and ClaudeCode —
// see agent/default/app/ClaudeCode/memory.js for the sibling implementation).
// Both env vars are set by backend.ts (agentCoreApp.addRuntimeEnvironmentVariable);
// empty on a branch where the memory isn't wired up, in which case persistence
// is skipped rather than failing the run.
const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || '';
const MEMORY_REGION = process.env.AGENTCORE_MEMORY_REGION || process.env.AWS_REGION;
const memoryClient = MEMORY_ID ? new BedrockAgentCoreClient({ region: MEMORY_REGION }) : null;

// One Strands agent template, cloned per-thread by StrandsAgent (see
// @ag-ui/aws-strands) so each AG-UI threadId gets its own conversation state.
const strandsAgent = new Agent({
  model: MODEL_ID,
  systemPrompt: SYSTEM_PROMPT,
});

const aguiAgent = new StrandsAgent({
  agent: strandsAgent,
  name: 'agui_agent',
  description: 'AG-UI-native agent for agents4energy',
});

const app = express();
app.use(cors({ origin: '*' }));
// InvokeAgentRuntime can forward a large payload (message history, tool
// results); lift the default express.json limit accordingly.
app.use(express.json({ limit: '25mb' }));

app.get('/ping', (_req, res) => {
  res.status(200).json({ status: 'Healthy' });
});

function log(...args: unknown[]): void {
  console.log('[agui-invocations]', ...args);
}

/** Extract plain text from the last user message in a RunAgentInput, for the memory USER turn. */
function lastUserMessageText(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (typeof (part as { text?: string })?.text === 'string' ? (part as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

app.post('/invocations', async (req, res) => {
  const parsed = RunAgentInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid RunAgentInput', issues: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  // InvokeAgentRuntime forwards runtimeSessionId as this header (not the JSON
  // body). Falls back to the AG-UI threadId so a direct/local invocation
  // (no AgentCore proxy in front) still gets a stable memory session id.
  const sessionId = req.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id') || input.threadId || randomUUID();

  log(`threadId=${input.threadId} runId=${input.runId} sessionId=${sessionId}`);

  const encoder = new EventEncoder({ accept: req.get('accept') ?? undefined });
  res.setHeader('Content-Type', encoder.getContentType());
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const write = (event: BaseEvent) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(encoder.encode(event));
  };

  void persistUserPrompt(memoryClient, {
    memoryId: MEMORY_ID,
    sessionId,
    prompt: lastUserMessageText(input.messages as { role: string; content: unknown }[]),
    log,
  });

  const accumulator = new AssistantTurnAccumulator();
  let stopped = false;
  const stop = () => { stopped = true; };
  res.once('close', stop);
  req.once('aborted', stop);

  try {
    for await (const event of aguiAgent.run(input)) {
      if (stopped || res.writableEnded || res.destroyed) break;
      accumulator.push(event);
      write(event);
    }
  } catch (err) {
    log('run failed:', err instanceof Error ? err.message : String(err));
    if (!stopped && !res.writableEnded) {
      write({
        type: EventType.RUN_ERROR,
        message: err instanceof Error ? err.message : String(err),
        code: 'AGUI_RUNTIME_ERROR',
      } as unknown as BaseEvent);
    }
  } finally {
    res.removeListener('close', stop);
    req.removeListener('aborted', stop);
    if (!res.writableEnded) res.end();
    await persistAssistantTurn(memoryClient, { memoryId: MEMORY_ID, sessionId, accumulator, log });
  }
});

app.listen(PORT, () => {
  console.log(`AG-UI runtime listening on port ${PORT}`);
});
