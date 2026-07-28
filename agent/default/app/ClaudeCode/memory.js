// AgentCore Memory persistence for the Claude Code runtime (issue #186).
//
// Mirrors the Converse-shaped payload the harness itself writes to
// MyHarnessMemory — each event's payload.conversational.content.text is a JSON
// string of a Bedrock Converse ContentBlock[] — so a run started via
// @agentcore-claude reads back through the exact same path as a harness run:
// web/amplify/functions/list-session-messages/handler.ts parses it, and
// web/lib/converse-to-agui.ts maps it to AG-UI messages for the chat UI.
//
// Best-effort throughout: a CreateEvent failure is logged and swallowed. Memory
// persistence must never fail, delay, or retry into the actual Claude Code run.
import { CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore';

// The harness SDK stores memory under the agent name ("default") as the
// actorId, not any per-user identity. Matches list-session-messages/handler.ts
// and web/lib/harness-agent.ts so the chat UI reads the same actor's events.
const ACTOR_ID = 'default';

/** One `claude --output-format stream-json` "assistant" content block -> a Converse ContentBlock, or null to drop it. */
function fromAssistantBlock(block) {
  if (!block || typeof block !== 'object') return null;
  switch (block.type) {
    case 'text':
      return block.text ? { text: block.text } : null;
    case 'thinking':
      return block.thinking ? { reasoningContent: { reasoningText: { text: block.thinking } } } : null;
    case 'tool_use':
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input ?? {} } };
    default:
      // Unrecognized block type (CLI version skew) — drop rather than guess.
      return null;
  }
}

// A tool_result block's `content` can be a bare string or an array of
// {type:"text"} blocks (Claude Code's Anthropic-Messages-API-shaped content).
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

/** One `claude --output-format stream-json` "user" content block (tool results) -> a Converse ContentBlock, or null. */
function fromUserBlock(block) {
  if (!block || block.type !== 'tool_result') return null;
  return {
    toolResult: {
      toolUseId: block.tool_use_id,
      status: block.is_error ? 'error' : 'success',
      content: [{ text: toolResultText(block.content) }],
    },
  };
}

async function createEvent(client, { memoryId, sessionId, role, blocks, log }) {
  if (!client || !memoryId || !sessionId || !blocks.length) return;
  try {
    await client.send(new CreateEventCommand({
      memoryId,
      actorId: ACTOR_ID,
      sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role, content: { text: JSON.stringify(blocks) } } }],
    }));
  } catch (err) {
    log?.(`[memory] CreateEvent failed (role=${role}):`, err?.message || String(err));
  }
}

/** Persist the initiating request's prompt as its own USER turn, before the CLI runs. */
export function persistUserPrompt(client, { memoryId, sessionId, prompt, log }) {
  return createEvent(client, { memoryId, sessionId, role: 'USER', blocks: [{ text: prompt }], log });
}

/**
 * Persist one parsed `claude --output-format stream-json` line as a Converse-
 * shaped memory event. Resolves without writing for message types that aren't
 * a conversational turn ("system" init, "result" run summary) or that produce
 * no renderable blocks.
 */
export function persistClaudeStreamEvent(client, { memoryId, sessionId, event, log }) {
  if (event?.type === 'assistant') {
    const blocks = (event.message?.content ?? []).map(fromAssistantBlock).filter(Boolean);
    return createEvent(client, { memoryId, sessionId, role: 'ASSISTANT', blocks, log });
  }
  if (event?.type === 'user') {
    // Converse convention: tool results travel back in a USER-role turn.
    const blocks = (event.message?.content ?? []).map(fromUserBlock).filter(Boolean);
    return createEvent(client, { memoryId, sessionId, role: 'USER', blocks, log });
  }
  return Promise.resolve();
}
