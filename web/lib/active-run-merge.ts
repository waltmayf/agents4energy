import type { Message } from '@ag-ui/client';

/** Shape loadHistory needs from an ActiveRun row (see active-run.ts). */
export interface ActiveRunSnapshot {
  status?: string | null;
  accumulatedText?: string | null;
  messageId?: string | null;
  updatedAt?: string | null;
}

/** A crashed browser leaves a stale 'streaming' row with no one left to clear it —
 * ignore snapshots that haven't been touched in a while rather than showing a
 * permanently stuck in-flight bubble. */
const ACTIVE_RUN_STALE_MS = 60_000;

/**
 * True when `active` represents a genuinely in-flight turn: status is
 * 'streaming' and it was touched recently enough not to be a crashed browser's
 * abandoned row (see ACTIVE_RUN_STALE_MS). Shared by `mergeActiveRunSnapshot`
 * (whether to show the in-flight bubble) and `HarnessAgent`/`ClaudeCodeAgent`'s
 * `refreshHistory()` (whether to show the chat as "responding" — issue #451).
 */
export function isActiveRunStreaming(active: ActiveRunSnapshot | null): boolean {
  if (!active || active.status !== 'streaming') return false;
  const updatedAtMs = active.updatedAt ? new Date(active.updatedAt).getTime() : NaN;
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= ACTIVE_RUN_STALE_MS;
}

/** Plain text of an AG-UI message (user/assistant turns are simple text). */
function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/** Collapse all whitespace so block-join separators (#244) or streaming-vs-persisted
 * formatting differences can't defeat the comparison below. */
function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/** True when the two texts plausibly describe the same turn — one contains the other
 * once whitespace is ignored (handles both the plain-text case and the multi-text-block
 * case, where converse-to-agui joins persisted blocks with "\n\n" that the raw streamed
 * accumulation never inserted). */
function sameTurnText(a: string, b: string): boolean {
  const sa = stripWhitespace(a);
  const sb = stripWhitespace(b);
  return sa.length > 0 && sb.length > 0 && (sa.includes(sb) || sb.includes(sa));
}

/**
 * Append the ActiveRun snapshot's in-flight assistant text to `msgs`, unless the same
 * turn is already present.
 *
 * The old guard compared `active.messageId` (a client-generated crypto.randomUUID(), see
 * harness-stream-to-agui.ts) against persisted message ids (AgentCore-assigned eventIds,
 * see converse-to-agui.ts) — two id spaces that never intersect, so it never actually
 * suppressed anything. `clearActiveRun()` after a run finishes is fire-and-forget
 * (harness-agent.ts), so there is a real window where a turn is already persisted to
 * memory AND the ActiveRun row still exists with status 'streaming' — a poll (this tab's
 * or another tab's) landing in that window rendered the turn twice (#242). Matching by
 * content instead of id closes that window regardless of timing.
 */
export function mergeActiveRunSnapshot(msgs: Message[], active: ActiveRunSnapshot | null): Message[] {
  if (!isActiveRunStreaming(active) || !active?.messageId) return msgs;

  const text = active.accumulatedText?.trim();
  if (!text) return msgs;

  const alreadyPersisted = msgs.some((m) => m.role === 'assistant' && sameTurnText(text, messageText(m)));
  if (alreadyPersisted) return msgs;

  // `timestamp` isn't part of the AG-UI Message schema; attached via cast the
  // same way converse-to-agui.ts does, so the "most recent message" timestamp
  // UI (issue #451) has something to show for an in-flight turn too.
  return [
    ...msgs,
    { id: active.messageId, role: 'assistant', content: active.accumulatedText, timestamp: active.updatedAt } as Message,
  ];
}
