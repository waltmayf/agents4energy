'use client';
import { useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import type { AbstractAgent } from '@ag-ui/client';
import { messageText } from '@/lib/harness-agent';
import { deriveSessionTitle, isPlaceholderName } from '@/lib/session-title';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

/**
 * Auto-names a chat session from its first user message (issue #352). A fresh
 * session is created with the `'New Chat'` placeholder (see useChatSession); the
 * first time the user sends a turn, we derive a compact title and write it to
 * `ChatSession.name` — but only if the session still carries the placeholder, so
 * a manual rename (see the session-list UI) is never clobbered.
 *
 * The write is fire-and-forget: it must not delay or block the agent's response.
 * We subscribe to the agent's `onNewMessage` (fires for both user and assistant
 * turns) and act on the first `user` message we observe for this session.
 */
export function useAutoNameSession(agent: AbstractAgent | null, sessionId: string | null): void {
  useEffect(() => {
    if (!agent || !sessionId) return;

    // Guard so we attempt the rename at most once per mount — after the first
    // user turn there's nothing more to do, and re-checking every message would
    // be wasted work (and could race a user's manual rename).
    let done = false;

    const { unsubscribe } = agent.subscribe({
      onNewMessage: ({ message }) => {
        if (done || message.role !== 'user') return;
        const title = deriveSessionTitle(messageText(message));
        if (!title) return;
        done = true;
        void renameIfPlaceholder(sessionId, title);
      },
    });

    return () => unsubscribe();
  }, [agent, sessionId]);
}

/**
 * Set the session name only when it's still the placeholder — a read-then-write
 * that deliberately loses to a concurrent manual rename (the user's intent wins).
 * All failures are swallowed: a naming hiccup must never surface in the chat.
 */
async function renameIfPlaceholder(sessionId: string, title: string): Promise<void> {
  try {
    const { data: session } = await amplifyClient.models.ChatSession.get({ id: sessionId });
    if (!session || !isPlaceholderName(session.name)) return;
    await amplifyClient.models.ChatSession.update({ id: sessionId, name: title });
  } catch (err) {
    console.warn('[useAutoNameSession] could not auto-name session', err);
  }
}
