import type { Message, ToolCall } from '@ag-ui/client';
import { elicitationFriendlyMessage, parseMcpElicitation } from './mcp-elicitation.ts';
import {
  encodeToolResultParts,
  hasStructuredPart,
  toToolResultPart,
  type ToolResultPart,
} from './tool-result-content.ts';

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
 * Attach the stored event's timestamp to a message via cast — `timestamp`
 * isn't part of the AG-UI Message schema, same pattern as the `error` field
 * tool-result messages already smuggle through below. Read by the "most
 * recent message" timestamp UI (issue #451); a missing/null timestamp is
 * left off rather than defaulting to "now", so the UI can tell a genuinely
 * unknown time apart from a fresh one.
 */
function withTimestamp<T extends Message>(msg: T, timestamp: string | null | undefined): T {
  if (timestamp) (msg as unknown as { timestamp?: string }).timestamp = timestamp;
  return msg;
}

/** Read the `timestamp` a Message may carry (see withTimestamp) — undefined if never set. */
export function messageTimestamp(m: Message): string | undefined {
  return (m as unknown as { timestamp?: string }).timestamp;
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
    withTimestamp(
      {
        id: base,
        role: 'assistant',
        toolCalls: [
          { id: toolCallId, type: 'function', function: { name: toolMatch[1], arguments: '{}' } },
        ],
      } as unknown as Message,
      ev.timestamp,
    ),
    withTimestamp(
      {
        id: idFor(next.eventId || `msg-${index + 1}`, 'toolresult'),
        role: 'tool',
        toolCallId,
        content: next.text!.trim(),
      } as Message,
      next.timestamp,
    ),
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
    return [withTimestamp({ id: base, role, content: text } as Message, ev.timestamp)];
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
      const parts: ToolResultPart[] = Array.isArray(tr.content)
        ? tr.content.map(toToolResultPart).filter((p): p is ToolResultPart => p !== null)
        : [];
      // A UI block (a JSON content item shaped `{ mimeType, spec?, html? }`)
      // is preserved via the shared structured envelope so the renderer
      // (#475) can decode it; plain text/JSON results keep today's flattened
      // string exactly, so existing tool cards render unchanged.
      const resultText = hasStructuredPart(parts)
        ? encodeToolResultParts(parts)
        : parts
            .map((p) => (p.kind === 'text' ? p.text : ''))
            .filter(Boolean)
            .join('\n');
      // MCP elicitation (epic #412 slice 4): if this stored tool result is a
      // -32042 consent-required error, show the friendly stand-in instead of
      // the raw JSON-RPC payload on reload too — the live "Authenticate"
      // banner only reacts to the in-flight CUSTOM event, but a page refresh
      // should never surface the protocol error itself either.
      const elicitation = parseMcpElicitation(resultText);
      out.push({
        id: idFor(base, `toolresult-${seq++}`),
        role: 'tool',
        toolCallId: tr.toolUseId ?? idFor(base, `tool-${seq}`),
        content: elicitation ? elicitationFriendlyMessage(elicitation) : resultText,
        ...(tr.status === 'error' && !elicitation ? { error: resultText } : {}),
      } as Message);
    }
  }

  // Emit the assistant/user message carrying text and any tool calls. Reasoning
  // and tool-result messages are ordered before it so the transcript reads
  // reasoning → answer → tool activity naturally on reload.
  //
  // Each entry in textChunks is one already-assembled Converse text content
  // block, not a raw streaming delta, so joining separate blocks with '\n\n'
  // can't split a sentence that legitimately arrived as multiple deltas (those
  // are concatenated into a single block's `text` upstream, before this file
  // ever sees them). Without a separator here, a turn with more than one text
  // block (e.g. #244 — a leaked multi-sentence Harmony response split across
  // blocks) renders as one run-on paragraph with sentences glued together.
  const content = textChunks.join('\n\n').trim();
  if (content || toolCalls.length) {
    const msg: Record<string, unknown> = { id: base, role };
    if (content) msg.content = content;
    if (role === 'assistant' && toolCalls.length) msg.toolCalls = toolCalls;
    out.push(msg as unknown as Message);
  }

  // Every message above came from this one stored event, so they all share its timestamp.
  return out.map((m) => withTimestamp(m, ev.timestamp));
}

/** How close two same-content events' timestamps must be to be treated as one re-persisted turn. */
const DEDUPE_WINDOW_MS = 5000;

/** Key used to recognize "the same turn" for dedup purposes: role + exact stored content. */
function dedupeKey(e: StoredEvent): string {
  return `${normalizeRole(e.role)}:${e.contentJson ?? (e.text ?? '').trim()}`;
}

/**
 * Drop re-persisted duplicate turns from an already time-sorted event list.
 *
 * Root cause (see #116): `harness-agent.ts` `run()` forwards the full
 * user/assistant message window on every `InvokeHarness` call, and the harness
 * persists whatever it's sent to AgentCore Memory in addition to what it
 * already had — so a turn that was included in an earlier invoke's window gets
 * re-stored as a brand-new event (its own `eventId`, a timestamp a few
 * seconds/milliseconds after the original). The duplication is in the stored
 * events themselves, not in this AG-UI mapping step, so we collapse it here
 * rather than trying to mask it with rendering-side de-duplication.
 *
 * Two events collapse into one only when they share role + identical content
 * AND land within DEDUPE_WINDOW_MS of each other — a user genuinely repeating
 * the same text in a later, distinct turn (minutes/turns apart) is kept.
 */
export function dedupeStoredEvents(events: StoredEvent[]): StoredEvent[] {
  const lastKeptTs = new Map<string, number>();
  const out: StoredEvent[] = [];
  for (const e of events) {
    const key = dedupeKey(e);
    const ts = e.timestamp ? new Date(e.timestamp).getTime() : NaN;
    const prevTs = lastKeptTs.get(key);
    const isDuplicate =
      prevTs !== undefined && !Number.isNaN(ts) && Math.abs(ts - prevTs) <= DEDUPE_WINDOW_MS;
    if (isDuplicate) continue;
    lastKeptTs.set(key, ts);
    out.push(e);
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
