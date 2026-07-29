// AgentCore Memory persistence for the AG-UI runtime (issue #176).
//
// Mirrors the Converse-shaped payload MyHarness and the ClaudeCode runtime
// write to MyHarnessMemory (see ../ClaudeCode/memory.js) — each event's
// payload.conversational.content.text is a JSON string of a Bedrock Converse
// ContentBlock[] — so a run started against this runtime reads back through
// the exact same path as a harness run: web/amplify/functions/
// list-session-messages/handler.ts parses it, and web/lib/converse-to-agui.ts
// maps it to AG-UI messages for the chat UI.
//
// Best-effort throughout: a CreateEvent failure is logged and swallowed.
// Memory persistence must never fail or delay the actual agent run.
import { BedrockAgentCoreClient, CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { BaseEvent } from '@ag-ui/core';

// Matches the actorId convention used by MyHarness/ClaudeCode — memory is
// namespaced by session, not per-user identity, so every runtime shares the
// same actor.
const ACTOR_ID = 'default';

export interface ConverseContentBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; status: 'success' | 'error'; content: { text: string }[] };
}

/** Accumulates AG-UI stream events for one run into Converse-shaped ContentBlock[]. */
export class AssistantTurnAccumulator {
  private blocks: ConverseContentBlock[] = [];
  private textByMessageId = new Map<string, string>();
  private toolNameByCallId = new Map<string, string>();
  private toolArgsByCallId = new Map<string, string>();

  /** Feed one AG-UI event emitted by the agent's run(). */
  push(event: BaseEvent): void {
    const e = event as unknown as Record<string, unknown>;
    switch (e.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = String(e.messageId ?? '');
        const delta = typeof e.delta === 'string' ? e.delta : '';
        this.textByMessageId.set(messageId, (this.textByMessageId.get(messageId) ?? '') + delta);
        break;
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = String(e.messageId ?? '');
        const text = this.textByMessageId.get(messageId);
        if (text) this.blocks.push({ text });
        this.textByMessageId.delete(messageId);
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = String(e.toolCallId ?? '');
        this.toolNameByCallId.set(toolCallId, String(e.toolCallName ?? ''));
        this.toolArgsByCallId.set(toolCallId, '');
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = String(e.toolCallId ?? '');
        const delta = typeof e.delta === 'string' ? e.delta : '';
        this.toolArgsByCallId.set(toolCallId, (this.toolArgsByCallId.get(toolCallId) ?? '') + delta);
        break;
      }
      case 'TOOL_CALL_END': {
        const toolCallId = String(e.toolCallId ?? '');
        const name = this.toolNameByCallId.get(toolCallId) ?? '';
        const argsStr = this.toolArgsByCallId.get(toolCallId) ?? '';
        let input: unknown = {};
        try {
          input = argsStr ? JSON.parse(argsStr) : {};
        } catch {
          input = { raw: argsStr };
        }
        this.blocks.push({ toolUse: { toolUseId: toolCallId, name, input } });
        this.toolNameByCallId.delete(toolCallId);
        this.toolArgsByCallId.delete(toolCallId);
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const toolCallId = String(e.toolCallId ?? '');
        const content = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '');
        this.blocks.push({
          toolResult: { toolUseId: toolCallId, status: 'success', content: [{ text: content }] },
        });
        break;
      }
      default:
        break;
    }
  }

  /** Content blocks accumulated so far, in emission order. */
  toBlocks(): ConverseContentBlock[] {
    return this.blocks;
  }
}

async function createEvent(
  client: BedrockAgentCoreClient | null,
  { memoryId, sessionId, role, blocks, log }: {
    memoryId: string;
    sessionId: string;
    role: 'USER' | 'ASSISTANT';
    blocks: ConverseContentBlock[];
    log?: (...args: unknown[]) => void;
  },
): Promise<void> {
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
    log?.(`[memory] CreateEvent failed (role=${role}):`, err instanceof Error ? err.message : String(err));
  }
}

/** Persist the run's new user prompt as its own USER turn, before the agent runs. */
export function persistUserPrompt(
  client: BedrockAgentCoreClient | null,
  opts: { memoryId: string; sessionId: string; prompt: string; log?: (...args: unknown[]) => void },
): Promise<void> {
  return createEvent(client, { ...opts, role: 'USER', blocks: [{ text: opts.prompt }] });
}

/** Persist the accumulated assistant turn (text + tool calls) for this run. */
export function persistAssistantTurn(
  client: BedrockAgentCoreClient | null,
  opts: {
    memoryId: string;
    sessionId: string;
    accumulator: AssistantTurnAccumulator;
    log?: (...args: unknown[]) => void;
  },
): Promise<void> {
  return createEvent(client, { ...opts, role: 'ASSISTANT', blocks: opts.accumulator.toBlocks() });
}
