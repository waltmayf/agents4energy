import { fetchAuthSession } from 'aws-amplify/auth';
import { fetchCredential, isExpiredOrExpiringSoon } from '@/lib/mcp-auth';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessMessage,
  type HarnessTool,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable, type Subscriber } from 'rxjs';

import outputs from '../amplify_outputs.json';
import { eventsToAguiMessages, type StoredEvent } from './converse-to-agui';
import {
  createHarnessStreamState,
  translateHarnessStreamEvent,
  finalizeHarnessStream,
  type HarnessStreamEvent,
} from './harness-stream-to-agui';

const custom = (outputs as { custom?: { agentcore_harness_arn?: string; agentcore_region?: string } }).custom;
export const HARNESS_ARN = custom?.agentcore_harness_arn as string;
export const DEPLOYMENT_REGION = custom?.agentcore_region ?? 'us-east-1';

// The harness SDK stores memory under the agent name ("default") as the actorId,
// not the Cognito user sub. Matches list-session-messages/handler.ts.
const ACTOR_ID = 'default';

// AppSync data client: maps MCP server URLs -> IDs when injecting stored OAuth
// credentials, and loads session history for connect().
const dataClient = generateClient<Schema>({ authMode: 'userPool' });

function makeClient(): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({
    region: DEPLOYMENT_REGION,
    credentials: async () => {
      const session = await fetchAuthSession();
      const creds = session.credentials;
      if (!creds) throw new Error('No AWS credentials — sign in first.');
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        expiration: creds.expiration,
      };
    },
  });
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/**
 * Per-invocation agent configuration. Injected into every InvokeHarness call
 * via the AG-UI run's `forwardedProps`, so switching agents takes effect
 * immediately (no redeploy) — same contract as the old transport.
 */
export interface HarnessAgentConfig {
  agentId?: string | null;
  systemPromptText?: string | null;
  modelId?: string | null;
  mcpServers?: McpServerConfig[];
}

/** Resolve MCP server configs into remote_mcp HarnessTools, injecting stored OAuth tokens. */
async function buildTools(mcpServers: McpServerConfig[]): Promise<HarnessTool[] | undefined> {
  if (!mcpServers.length) return undefined;

  // Map URL -> server ID so we can look up stored credentials.
  const serverRes = await dataClient.models.McpServer.list({ limit: 1000 });
  const urlToId = new Map<string, string>();
  (serverRes.data ?? []).forEach((s) => {
    if (s.url) urlToId.set(s.url, s.id);
  });

  const resolved = await Promise.all(
    mcpServers.map(async (s) => {
      const serverId = urlToId.get(s.url);
      if (serverId) {
        const cred = await fetchCredential(serverId);
        if (cred && !isExpiredOrExpiringSoon(cred)) {
          return {
            ...s,
            headers: { ...(s.headers || {}), Authorization: `Bearer ${cred.accessToken}` },
          };
        }
      }
      return s;
    }),
  );

  return resolved.map((s) => ({
    type: 'remote_mcp',
    name: s.name,
    config: {
      remoteMcp: {
        url: s.url,
        ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}),
      },
    },
  }));
}

/** Extract the plain text of an AG-UI message (user turns are simple text). */
function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((c) => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/**
 * A client-side AG-UI agent backed by the managed AgentCore Harness.
 *
 * - `run()`     — live turns: calls InvokeHarness, translates the Converse event
 *                 stream into AG-UI TEXT_MESSAGE_* events. The harness persists
 *                 the conversation to AgentCore Memory itself (keyed by session).
 * - `connect()` — history load: CopilotChat calls this when given an explicit
 *                 threadId (our AgentCore session id). We fetch the session's
 *                 stored events via the listSessionMessages query and emit one
 *                 MESSAGES_SNAPSHOT, which populates the transcript on reload.
 *
 * The threadId IS the AgentCore runtimeSessionId, so history and live streaming
 * share one identifier — no polling/merge dance.
 */
export class HarnessAgent extends AbstractAgent {
  private client: BedrockAgentCoreClient;
  private getConfig: () => HarnessAgentConfig;

  constructor(opts: { threadId?: string; getConfig?: () => HarnessAgentConfig }) {
    super({ agentId: 'default', threadId: opts.threadId });
    this.client = makeClient();
    this.getConfig = opts.getConfig ?? (() => ({}));
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const client = this.client;
    const config = this.getConfig();
    const sessionId = input.threadId || this.threadId || crypto.randomUUID();

    // Only the newest user message needs sending — the harness loads prior turns
    // from memory itself. Forward all user/assistant text just in case the
    // caller sends a fuller window; the harness dedupes by session.
    const harnessMessages: HarnessMessage[] = (input.messages ?? []).flatMap((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return [];
      const text = messageText(m);
      if (!text) return [];
      return [{ role: m.role, content: [{ text }] }];
    });

    return new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const abort = new AbortController();
      let cancelled = false;

      (async () => {
        const runId = input.runId || crypto.randomUUID();
        subscriber.next({ type: EventType.RUN_STARTED, threadId: sessionId, runId } as BaseEvent);

        try {
          const tools = await buildTools(config.mcpServers ?? []);

          const response = await client.send(
            new InvokeHarnessCommand({
              harnessArn: HARNESS_ARN,
              runtimeSessionId: sessionId,
              messages: harnessMessages,
              systemPrompt: config.systemPromptText ? [{ text: config.systemPromptText }] : undefined,
              model: config.modelId ? { bedrockModelConfig: { modelId: config.modelId } } : undefined,
              tools,
            }),
            { abortSignal: abort.signal },
          );

          // Translate the harness Converse stream (text + toolUse + toolResult)
          // into AG-UI events. Tool activity is handled here too — otherwise it
          // only shows up after a reload rebuilds it from memory.
          const streamState = createHarnessStreamState();
          for await (const event of response.stream ?? []) {
            if (cancelled) break;
            if (event.validationException || event.internalServerException || event.runtimeClientError) {
              const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
              throw new Error(ex?.message ?? 'Harness stream exception');
            }
            for (const aguiEvent of translateHarnessStreamEvent(
              event as HarnessStreamEvent,
              streamState,
              () => crypto.randomUUID(),
            )) {
              subscriber.next(aguiEvent);
            }
          }

          if (!cancelled) {
            for (const aguiEvent of finalizeHarnessStream(streamState)) {
              subscriber.next(aguiEvent);
            }
          }
          subscriber.next({ type: EventType.RUN_FINISHED, threadId: sessionId, runId } as BaseEvent);
          subscriber.complete();
        } catch (err) {
          const name = err instanceof Error ? err.name : undefined;
          if (name === 'AbortError' || cancelled) {
            subscriber.complete();
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          subscriber.next({ type: EventType.RUN_ERROR, message } as BaseEvent);
          subscriber.error(err instanceof Error ? err : new Error(message));
        }
      })();

      return () => {
        cancelled = true;
        abort.abort();
      };
    });
  }

  /**
   * Poll-friendly history refresh. Loads the session's persisted history and,
   * when it contains more messages than are currently shown, replaces the
   * transcript via setMessages — which fires onMessagesChanged on CopilotChat's
   * subscriber and re-renders live, no page reload.
   *
   * This is what makes externally-written turns appear as they arrive: a webhook
   * run (or another tab) writes to the same AgentCore session; connect() only
   * runs on (re)mount, so without polling those messages surface only on reload.
   *
   * Guards keep it safe to run on an interval:
   *  - never applies while a live local turn is streaming (isRunning), so it
   *    can't clobber optimistic/streamed messages not yet persisted to memory.
   *  - only grows the transcript (applies when the fetched set is larger), so a
   *    persistence lag that momentarily returns fewer events can't wipe the
   *    messages the user is currently looking at.
   *
   * Returns the number of messages shown afterwards, for idle-backoff bookkeeping.
   */
  async refreshHistory(): Promise<number> {
    if (this.isRunning) return this.messages.length;
    const sessionId = this.threadId;
    if (!sessionId) return this.messages.length;

    const history = await loadHistory(sessionId);
    // Re-check isRunning: a local turn may have started during the async fetch.
    if (!this.isRunning && history.length > this.messages.length) {
      this.setMessages(history);
    }
    return this.messages.length;
  }

  /**
   * Load persisted history for this thread and emit it as a single
   * MESSAGES_SNAPSHOT. Called by CopilotChat when resuming an existing thread.
   */
  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    const sessionId = input.threadId || this.threadId;

    return new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      let cancelled = false;
      const runId = input.runId || crypto.randomUUID();

      (async () => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: sessionId, runId } as BaseEvent);
        try {
          const messages = await loadHistory(sessionId);
          if (cancelled) return;
          subscriber.next({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);
          subscriber.next({ type: EventType.RUN_FINISHED, threadId: sessionId, runId } as BaseEvent);
          subscriber.complete();
        } catch (err) {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : String(err);
          subscriber.next({ type: EventType.RUN_ERROR, message } as BaseEvent);
          subscriber.error(err instanceof Error ? err : new Error(message));
        }
      })();

      return () => {
        cancelled = true;
      };
    });
  }
}

/**
 * Fetch all post-summary events for a session (paging through the query) and map
 * them to AG-UI messages. The Converse→AG-UI parse happens exactly once, in
 * converse-to-agui.ts.
 */
export async function loadHistory(sessionId: string): Promise<Message[]> {
  const all: StoredEvent[] = [];
  let nextToken: string | null | undefined = null;

  do {
    const result = await dataClient.queries.listSessionMessages({
      sessionId,
      actorId: ACTOR_ID,
      ...(nextToken ? { nextToken } : {}),
    });
    if (result.errors?.length) break;
    for (const e of result.data?.events ?? []) {
      if (e) all.push(e as StoredEvent);
    }
    nextToken = result.data?.nextToken;
  } while (nextToken);

  // Events may be returned in descending order per page. Sort them chronologically
  // (oldest first) before converting to AG-UI messages to ensure correct display order.
  const sorted = all.sort((a, b) => {
    const at = new Date(a.timestamp).getTime();
    const bt = new Date(b.timestamp).getTime();
    return at - bt;
  });
  return eventsToAguiMessages(sorted);
}
