'use client';
import { useEffect } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import type { AbstractAgent } from '@ag-ui/client';
import { messageText } from '@/lib/harness-agent';
import { deriveSessionTitle, isPlaceholderName } from '@/lib/session-title';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

/**
 * Auto-names a chat session from its first user message (issues #352, #374). A
 * fresh session is created with the `'New Chat'` placeholder (see
 * useChatSession); the first time the user sends a turn we name it in two
 * stages:
 *   1. Immediately write a cheap client-derived title (first few words) so the
 *      sidebar stops showing the placeholder without waiting on the network.
 *   2. Kick off a small Bedrock LLM call (the `nameChatSession` mutation) and,
 *      if it returns a better title, upgrade the name to it.
 * Both writes only apply while the session still carries an auto-name (the
 * placeholder or the stage-1 derived title), so a manual rename always wins.
 *
 * The whole thing is fire-and-forget: it must never delay or block the agent's
 * response. We subscribe to the agent's `onNewMessage` (fires for both user and
 * assistant turns) and act on the first `user` message we observe.
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
        const text = messageText(message);
        const derived = deriveSessionTitle(text);
        if (!derived) return;
        done = true;
        void autoNameSession(sessionId, text, derived);
      },
    });

    return () => unsubscribe();
  }, [agent, sessionId]);
}

/**
 * Two-stage auto-name for a session's first turn. Stage 1 applies the cheap
 * derived title immediately; stage 2 upgrades it to an LLM-generated title. Each
 * write is guarded by `renameIfAuto`, so a concurrent manual rename (or a
 * user-set name) is never clobbered. All failures are swallowed: a naming
 * hiccup must never surface in the chat.
 */
async function autoNameSession(sessionId: string, firstMessage: string, derived: string): Promise<void> {
  // Stage 1 — instant, offline-derivable title.
  await renameIfAuto(sessionId, derived);

  // Stage 2 — LLM-generated title. Only overwrite the derived title (still an
  // auto-name); if the model call fails or returns nothing, stage 1 stands.
  try {
    const { data: llmTitle } = await amplifyClient.mutations.nameChatSession({ firstMessage });
    const title = llmTitle?.trim();
    if (title && title !== derived) {
      await renameIfAuto(sessionId, title, derived);
    }
  } catch (err) {
    console.warn('[useAutoNameSession] LLM naming failed; keeping derived title', err);
  }
}

/**
 * Set the session name only when it's still an auto-name — i.e. the placeholder
 * or (optionally) a known prior auto-title. A read-then-write that deliberately
 * loses to a concurrent manual rename (the user's intent wins).
 */
async function renameIfAuto(sessionId: string, title: string, priorAutoTitle?: string): Promise<void> {
  try {
    const { data: session } = await amplifyClient.models.ChatSession.get({ id: sessionId });
    if (!session) return;
    const current = session.name?.trim() ?? '';
    const claimable = isPlaceholderName(current) || (!!priorAutoTitle && current === priorAutoTitle.trim());
    if (!claimable) return;
    await amplifyClient.models.ChatSession.update({ id: sessionId, name: title });
  } catch (err) {
    console.warn('[useAutoNameSession] could not auto-name session', err);
  }
}
