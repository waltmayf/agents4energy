'use client';
import { useEffect, useState } from 'react';
import type { AbstractAgent, Message } from '@ag-ui/client';
import { messageText } from '@/lib/harness-agent';

export interface LastUserMessage {
  id: string;
  text: string;
}

function computeLastUserMessage(messages: readonly Message[]): LastUserMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user') {
      const text = messageText(m).trim();
      if (text) return { id: m.id, text };
    }
  }
  return null;
}

/**
 * Tracks the most recent user turn in `agent`'s transcript (issue #457), so
 * the chat view can pin a short blurb of it above the scrollable message
 * list — an anchor the operator can use to tell what prompt the messages
 * below are responding to while scrolled up through earlier history.
 *
 * Re-derives on every `onMessagesChanged` notification, mirroring
 * `useAwaitingInput` — a history load via `connect()`, a poll-driven
 * `refreshHistory()`, or a newly sent/streamed turn all keep this in sync.
 */
export function useLastUserMessage(agent: AbstractAgent): LastUserMessage | null {
  const [{ forAgent, state }, setSnapshot] = useState(() => ({
    forAgent: agent,
    state: computeLastUserMessage(agent.messages),
  }));

  useEffect(() => {
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: ({ messages }) => setSnapshot({ forAgent: agent, state: computeLastUserMessage(messages) }),
    });
    return unsubscribe;
  }, [agent]);

  return forAgent === agent ? state : computeLastUserMessage(agent.messages);
}
