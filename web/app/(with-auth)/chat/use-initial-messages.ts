'use client';
import { useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import type { UIMessage } from 'ai';

// The harness SDK stores memory under the agent name ("default") as the actorId,
// not the Cognito user sub. This is visible in CloudWatch:
//   /users/default/preferences, /summaries/default/{sessionId}, etc.
const ACTOR_ID = 'default';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

export interface SessionData {
  messages: UIMessage[];
  /** AgentCore-managed rolling summary (SUMMARIZATION strategy), or null if none yet. */
  summary: string | null;
  /** ISO timestamp of when the summary was last produced. Events at or before this
   *  timestamp are already captured in the summary and excluded from `messages`. */
  summaryTimestamp: string | null;
  /** AgentCore MemoryRecord ID for the summary — pass to updateSessionSummary to edit it. */
  summaryRecordId: string | null;
}

/** Fetch post-summary events + the AgentCore session summary in a single Lambda call. */
export async function fetchSessionMessages(sessionId: string): Promise<SessionData> {
  const allEvents: NonNullable<Schema['ListSessionMessagesResult']['type']['events']> = [];
  let nextToken: string | null | undefined = null;
  let summary: string | null = null;
  let summaryTimestamp: string | null = null;
  let summaryRecordId: string | null = null;

  do {
    const result = await amplifyClient.queries.listSessionMessages({
      sessionId,
      actorId: ACTOR_ID,
      ...(nextToken ? { nextToken } : {}),
    });
    if (result.errors?.length) break;
    allEvents.push(...(result.data?.events ?? []));
    // Summary fields are the same on every page; capture on the last page.
    if (!result.data?.nextToken) {
      summary = result.data?.summary ?? null;
      summaryTimestamp = result.data?.summaryTimestamp ?? null;
      summaryRecordId = result.data?.summaryRecordId ?? null;
    }
    nextToken = result.data?.nextToken;
  } while (nextToken);

  const messages = allEvents
    .filter((e): e is NonNullable<typeof e> => e != null)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((e, i) => {
      // Attempt to parse JSON-encoded message content from AgentCore memory.
      let parsed: any = null;
      try {
        parsed = JSON.parse(e.text);
      } catch (_) {
        // Not JSON, fall back to raw text.
      }
      const parts: any[] = [];
      let combinedText = '';
      if (parsed && parsed.message && parsed.message.content) {
        for (const item of parsed.message.content) {
          if (item.toolResult && Array.isArray(item.toolResult.content)) {
            const texts = item.toolResult.content.map((c: any) => c.text).filter(Boolean);
            parts.push({ type: 'toolResult' as const, content: texts });
            combinedText += texts.join('\n') + '\n';
          } else if (item.reasoningContent && item.reasoningContent.reasoningText && item.reasoningContent.reasoningText.text) {
            const txt = item.reasoningContent.reasoningText.text;
            parts.push({ type: 'text' as const, text: txt });
            combinedText += txt + '\n';
          } else if (item.text) {
            parts.push({ type: 'text' as const, text: item.text });
            combinedText += item.text + '\n';
          }
        }
      } else {
        parts.push({ type: 'text' as const, text: e.text });
        combinedText = e.text;
      }
      combinedText = combinedText.trimEnd();
      return {
        id: e.eventId ?? `msg-${i}`,
        role: (e.role === 'assistant' || e.role === 'user' ? e.role : 'assistant') as UIMessage['role'],
        content: combinedText,
        parts,
        createdAt: e.timestamp ? new Date(e.timestamp) : new Date(),
      };
    });

  return { messages, summary, summaryTimestamp, summaryRecordId };
}

export type InitialMessagesState =
  | { status: 'loading' }
  | { status: 'ready'; messages: UIMessage[]; summary: string | null; summaryTimestamp: string | null; summaryRecordId: string | null };

export function useInitialMessages(sessionId: string | null): InitialMessagesState {
  const [state, setState] = useState<InitialMessagesState>({ status: 'loading' });

  useEffect(() => {
    if (!sessionId) {
      setState({ status: 'ready', messages: [], summary: null, summaryTimestamp: null, summaryRecordId: null });
      return;
    }

    setState({ status: 'loading' });
    let cancelled = false;

    async function load() {
      try {
        const { messages, summary, summaryTimestamp, summaryRecordId } = await fetchSessionMessages(sessionId!);
        if (cancelled) return;
        setState({ status: 'ready', messages, summary, summaryTimestamp, summaryRecordId });
      } catch (err) {
        console.error('[useInitialMessages] failed', err);
        if (!cancelled) setState({ status: 'ready', messages: [], summary: null, summaryTimestamp: null, summaryRecordId: null });
      }
    }

    load();
    return () => { cancelled = true; };
  }, [sessionId]);

  return state;
}
