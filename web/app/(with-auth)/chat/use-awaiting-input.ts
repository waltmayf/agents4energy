'use client';
import { useEffect, useState } from 'react';
import type { AbstractAgent, Message } from '@ag-ui/client';
import { parseAwaitingInputMarker } from '@/lib/awaiting-input';

export interface AwaitingInputState {
  awaiting: boolean;
  question: string;
}

const NOT_AWAITING: AwaitingInputState = { awaiting: false, question: '' };

function computeAwaitingInput(messages: readonly Message[]): AwaitingInputState {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content !== 'string') return NOT_AWAITING;
  const question = parseAwaitingInputMarker(last.content);
  return question === null ? NOT_AWAITING : { awaiting: true, question };
}

/**
 * Tracks whether `agent`'s most recent message is the "awaiting_input" marker
 * the ClaudeCode runtime persists to AgentCore Memory when a run pauses mid-
 * question instead of completing (issue #185, increments 1-3). Re-derives on
 * every `onMessagesChanged` notification — a history load via `connect()`, a
 * poll-driven `refreshHistory()`, or the user's answer being appended — so the
 * banner appears/disappears in lockstep with the transcript rather than
 * needing its own fetch.
 */
export function useAwaitingInput(agent: AbstractAgent): AwaitingInputState {
  // Keyed by `agent` identity so switching agents (e.g. the agent picker)
  // re-initializes from the new instance's current messages, rather than
  // needing a setState call inside the effect below just to catch up.
  const [{ forAgent, state }, setSnapshot] = useState(() => ({
    forAgent: agent,
    state: computeAwaitingInput(agent.messages),
  }));

  useEffect(() => {
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: ({ messages }) => setSnapshot({ forAgent: agent, state: computeAwaitingInput(messages) }),
    });
    return unsubscribe;
  }, [agent]);

  return forAgent === agent ? state : computeAwaitingInput(agent.messages);
}
