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
  if (!active || active.status !== 'streaming' || !active.messageId) return msgs;

  const text = active.accumulatedText?.trim();
  if (!text) return msgs;

  const updatedAtMs = active.updatedAt ? new Date(active.updatedAt).getTime() : NaN;
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > ACTIVE_RUN_STALE_MS) return msgs;

  const alreadyPersisted = msgs.some((m) => m.role === 'assistant' && sameTurnText(text, messageText(m)));
  if (alreadyPersisted) return msgs;

  return [...msgs, { id: active.messageId, role: 'assistant', content: active.accumulatedText } as Message];
}
