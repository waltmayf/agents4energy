import type { Message, ToolCall } from '@ag-ui/client';

/**
 * Maps stored Bedrock Converse content into AG-UI `Message[]` for a
 * MESSAGES_SNAPSHOT. This is the SINGLE place history is parsed for the chat UI:
 * the Lambda already parsed the harness payload into `contentJson` (a Converse
 * `ContentBlock[]`), and here we translate those blocks — text, toolUse,
 * toolResult, reasoningContent — straight into role-discriminated AG-UI
 * messages. No re-parsing of ambiguous flattened strings.
 *
 * A single stored Converse message can expand into several AG-UI messages
 * because AG-UI models tool calls, tool results, and reasoning as their own
 * top-level messages:
 *   - assistant text/toolUse  → one `assistant` message (content + toolCalls)
 *   - toolResult              → one `tool` message per result (toolCallId link)
 *   - reasoningContent        → one `reasoning` message
 *   - user text               → one `user` message
 */

/** One stored event as returned by the listSessionMessages query. */
export interface StoredEvent {
  eventId?: string | null;
  role: string;
  /** Flattened plain text (fallback when contentJson is absent). */
  text?: string | null;
  /** JSON string of the Converse ContentBlock[] for this message. */
  contentJson?: string | null;
}

/** A loosely-typed Bedrock Converse content block (text / toolUse / toolResult / reasoning). */
interface ContentBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: unknown };
  toolResult?: { toolUseId?: string; status?: string; content?: ContentBlock[] };
  reasoningContent?: { reasoningText?: { text?: string } };
  json?: unknown;
}

function normalizeRole(role: string): 'user' | 'assistant' {
  return role.toLowerCase() === 'user' ? 'user' : 'assistant';
}

/** Stable id generator so re-renders don't reshuffle keys. */
function idFor(base: string, suffix: string | number): string {
  return `${base}:${suffix}`;
}

function parseBlocks(ev: StoredEvent): ContentBlock[] | null {
  if (!ev.contentJson) return null;
  try {
    const parsed = JSON.parse(ev.contentJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Convert one stored event into zero or more AG-UI messages. */
export function eventToMessages(ev: StoredEvent, index: number): Message[] {
  const base = ev.eventId || `msg-${index}`;
  const role = normalizeRole(ev.role);
  const blocks = parseBlocks(ev);

  // No structured content: fall back to a single text message.
  if (!blocks) {
    const text = ev.text?.trim() ?? '';
    if (!text) return [];
    return [{ id: base, role, content: text } as Message];
  }

  const out: Message[] = [];
  const textChunks: string[] = [];
  const toolCalls: ToolCall[] = [];
  let seq = 0;

  for (const block of blocks) {
    if (typeof block?.text === 'string' && block.text) {
      textChunks.push(block.text);
    } else if (block?.reasoningContent?.reasoningText?.text) {
      // Reasoning renders as its own message so CopilotChat can style it.
      out.push({
        id: idFor(base, `reasoning-${seq++}`),
        role: 'reasoning',
        content: block.reasoningContent.reasoningText.text,
      } as Message);
    } else if (block?.toolUse) {
      const tu = block.toolUse;
      toolCalls.push({
        id: tu.toolUseId ?? idFor(base, `tool-${seq++}`),
        type: 'function',
        function: {
          name: tu.name ?? 'tool',
          // Converse toolUse.input is an object; AG-UI wants a JSON string.
          arguments: JSON.stringify(tu.input ?? {}),
        },
      });
    } else if (block?.toolResult) {
      // Tool results become their own `tool` messages, linked by toolCallId.
      const tr = block.toolResult;
      const resultText = Array.isArray(tr.content)
        ? tr.content
            .map((c: ContentBlock) =>
              typeof c?.text === 'string' ? c.text : c?.json != null ? JSON.stringify(c.json) : '',
            )
            .filter(Boolean)
            .join('\n')
        : '';
      out.push({
        id: idFor(base, `toolresult-${seq++}`),
        role: 'tool',
        toolCallId: tr.toolUseId ?? idFor(base, `tool-${seq}`),
        content: resultText,
        ...(tr.status === 'error' ? { error: resultText } : {}),
      } as Message);
    }
  }

  // Emit the assistant/user message carrying text and any tool calls. Reasoning
  // and tool-result messages are ordered before it so the transcript reads
  // reasoning → answer → tool activity naturally on reload.
  const content = textChunks.join('').trim();
  if (content || toolCalls.length) {
    const msg: Record<string, unknown> = { id: base, role };
    if (content) msg.content = content;
    if (role === 'assistant' && toolCalls.length) msg.toolCalls = toolCalls;
    out.push(msg as unknown as Message);
  }

  return out;
}

/** Map a full list of stored events (already time-sorted) to AG-UI messages. */
export function eventsToAguiMessages(events: StoredEvent[]): Message[] {
  return events.flatMap((ev, i) => eventToMessages(ev, i));
}
