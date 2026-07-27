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
  /** ISO timestamp of the event (used to sort history chronologically). */
  timestamp?: string | null;
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

/**
 * Split a text block into inline <reasoning>…</reasoning> segments and the
 * remaining answer text. gpt-oss-120b emits chain-of-thought this way instead
 * of as a separate reasoningContent block. Handles multiple/unclosed tags.
 */
function splitInlineReasoning(text: string): { reasoning: string[]; answer: string } {
  if (!/<reasoning>/i.test(text)) return { reasoning: [], answer: text };
  const reasoning: string[] = [];
  const answer = text
    .replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_m, inner) => {
      const t = String(inner).trim();
      if (t) reasoning.push(t);
      return '';
    })
    .replace(/<reasoning>([\s\S]*)$/i, (_m, inner) => {
      const t = String(inner).trim();
      if (t) reasoning.push(t);
      return '';
    })
    .trim();
  return { reasoning, answer };
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

/**
 * Built-in harness tools (shell/browser/file) aren't persisted to AgentCore
 * memory as structured toolUse/toolResult blocks the way MCP-server tool calls
 * are (issue #117) — the harness flattens them to plain text instead: the
 * assistant turn leaks its tool-invocation intent as `functions.<name>` (a
 * Harmony-format artifact, same family as #105/#149), and the tool's JSON
 * result arrives as its own "user" turn. The call's *arguments* are never
 * persisted in this format, so this is a best-effort, degraded reconstruction
 * (name + result, no arguments) — not a full recovery.
 */
const BUILTIN_TOOL_LEAK_RE = /\bfunctions\.([a-zA-Z0-9_]+)\b/;

/** True if flattened text is exactly a JSON object — the shape a tool result takes, not genuine user prose. */
function asBareResultObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * If `ev`/`next` are the leaked-builtin-tool-call pair described above,
 * return the degraded tool-call + tool-result messages to render instead of
 * the raw leak sentence / JSON bubble. Returns null when the pair doesn't
 * match (the normal, common case).
 */
function reconstructLeakedBuiltinTool(
  ev: StoredEvent,
  next: StoredEvent | undefined,
  index: number,
): Message[] | null {
  if (ev.contentJson || !next || next.contentJson) return null;
  if (normalizeRole(ev.role) !== 'assistant' || normalizeRole(next.role) !== 'user') return null;

  const toolMatch = ev.text?.match(BUILTIN_TOOL_LEAK_RE);
  const result = next.text ? asBareResultObject(next.text) : null;
  if (!toolMatch || !result) return null;

  const base = ev.eventId || `msg-${index}`;
  const toolCallId = idFor(base, 'builtin-tool');
  return [
    {
      id: base,
      role: 'assistant',
      toolCalls: [
        { id: toolCallId, type: 'function', function: { name: toolMatch[1], arguments: '{}' } },
      ],
    } as unknown as Message,
    {
      id: idFor(next.eventId || `msg-${index + 1}`, 'toolresult'),
      role: 'tool',
      toolCallId,
      content: next.text!.trim(),
    } as Message,
  ];
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
      // Some models (e.g. gpt-oss-120b) emit chain-of-thought inline as
      // <reasoning>…</reasoning> inside a text block rather than as a
      // reasoningContent block. Split those out so they render as thoughts,
      // not as assistant prose.
      const { reasoning, answer } = splitInlineReasoning(block.text);
      for (const r of reasoning) {
        out.push({ id: idFor(base, `reasoning-${seq++}`), role: 'reasoning', content: r } as Message);
      }
      if (answer) textChunks.push(answer);
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
  const out: Message[] = [];
  for (let i = 0; i < events.length; i++) {
    const leaked = reconstructLeakedBuiltinTool(events[i], events[i + 1], i);
    if (leaked) {
      out.push(...leaked);
      i++; // the result turn was consumed as part of the reconstructed pair
      continue;
    }
    out.push(...eventToMessages(events[i], i));
  }
  return out;
}
