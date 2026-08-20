'use client';
import { useEffect, useState } from 'react';
import type { AbstractAgent, Message } from '@ag-ui/client';
import { messageTimestamp } from '@/lib/converse-to-agui';

function computeLastMessageAt(messages: readonly Message[]): Date | null {
  const last = messages[messages.length - 1];
  if (!last) return null;
  const ts = messageTimestamp(last);
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // No stored timestamp yet — this message is still being built (a live local
  // stream, or an optimistic user turn not yet round-tripped through memory).
  // "Now" is accurate here, and keeps refreshing on every subsequent content
  // delta until the persisted copy (with a real timestamp) replaces it.
  return new Date();
}

/**
 * Tracks the timestamp of `agent`'s most recent message (issue #451), so the
 * chat can always show when the last activity happened — letting the user
 * judge for themselves whether a quiet transcript is waiting on a response or
 * just finished one, instead of wondering if the agent is stuck. Re-derives on
 * every `onMessagesChanged` notification (a history load, a poll-driven
 * refresh, or a live streaming delta) — same trigger useAwaitingInput uses.
 */
export function useLastMessageTimestamp(agent: AbstractAgent): Date | null {
  const [{ forAgent, at }, setSnapshot] = useState(() => ({
    forAgent: agent,
    at: computeLastMessageAt(agent.messages),
  }));

  useEffect(() => {
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: ({ messages }) => setSnapshot({ forAgent: agent, at: computeLastMessageAt(messages) }),
    });
    return unsubscribe;
  }, [agent]);

  return forAgent === agent ? at : computeLastMessageAt(agent.messages);
}
