import { fetchAuthSession } from 'aws-amplify/auth';
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
import { dedupeStoredEvents, eventsToAguiMessages, type StoredEvent } from './converse-to-agui';
import { fetchActiveRun, upsertActiveRun, clearActiveRun } from './active-run';
import { isActiveRunStreaming, mergeActiveRunSnapshot } from './active-run-merge';
import {
  createHarnessStreamState,
  translateHarnessStreamEvent,
  finalizeHarnessStream,
  type HarnessStreamEvent,
} from './harness-stream-to-agui';
import { buildRunErrorMessageEvents } from './harness-run-error';
import { slugifyToolName } from './tool-name-slug';
import { friendlyChatHarnessError } from './harness-error-message';
import { MCP_ELICITATION_EVENT_NAME, elicitationFriendlyMessage, parseMcpElicitation } from './mcp-elicitation';
import { encodeRuntimeUserId, SHARED_ACTOR_ID, type CallerIdentity } from './caller-identity';

const custom = (outputs as {
  custom?: { agentcore_harness_arn?: string; agentcore_region?: string; agentcore_gateway_endpoint?: string };
}).custom;
export const HARNESS_ARN = custom?.agentcore_harness_arn as string;
export const DEPLOYMENT_REGION = custom?.agentcore_region ?? 'us-east-1';
const GATEWAY_ENDPOINT = custom?.agentcore_gateway_endpoint;

// Per-user memory scoping (issue #256, Option A). Browser harness chats scope
// AgentCore memory to the signed-in user's Cognito `sub` (see run()'s
// InvokeHarnessCommand.actorId below); loadHistory then dual-reads the caller's
// own `sub` namespace AND the shared SHARED_ACTOR_ID namespace so webhook-
// initiated runs (which have no browser `sub`) still appear in the transcript.

// AppSync data client: loads session history for connect().
const dataClient = generateClient<Schema>({ authMode: 'userPool' });

export function makeClient(): BedrockAgentCoreClient {
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

/**
 * Read the signed-in caller's `sub` + `cognito:groups` off the Cognito ID
 * token (see caller-identity.ts), plus the raw ACCESS token. The harness
 * authorizes InvokeHarness via SigV4/Identity Pool credentials, not this JWT
 * — `identity` is forwarded as a trusted invoke argument (never used for
 * authorization by the browser itself), while `accessToken` is the credential
 * the *gateway's* CUSTOM_JWT authorizer requires (see buildTools).
 *
 * The gateway authorizer needs the ACCESS token, not the ID token: the ID
 * token carries `token_use: "id"` with no `scope`, so the authorizer rejects
 * it with HTTP 403 `insufficient_scope` before Cedar even runs (#327). The
 * access token carries `scope: "aws.cognito.signin.user.admin"`, and both
 * tokens carry `cognito:groups`, so Cedar's group matching still works.
 */
export async function fetchCallerIdentity(): Promise<{ identity: CallerIdentity; accessToken: string | null }> {
  const session = await fetchAuthSession();
  const payload = session.tokens?.idToken?.payload;
  const sub = typeof payload?.sub === 'string' ? payload.sub : null;
  const groupsClaim = payload?.['cognito:groups'];
  const groups = Array.isArray(groupsClaim) ? groupsClaim.filter((g): g is string => typeof g === 'string') : [];
  const accessToken = session.tokens?.accessToken?.toString() ?? null;
  return { identity: { sub, groups }, accessToken };
}

export interface McpServerConfig {
  name: string;
  url: string;
  // Unused by buildTools (gateway routing is mandatory, #338) — kept so
  // callers built for a direct MCP connection still type-check.
  headers?: Record<string, string>;
  // Required for buildTools to route this server through the gateway; a
  // server without one is skipped (see buildTools).
  gatewayTargetId?: string;
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

/**
 * Resolve MCP server configs into remote_mcp HarnessTools. Gateway routing is
 * mandatory (#338): every tool is sent to `GATEWAY_ENDPOINT` with the caller's
 * Cognito ACCESS token as `Authorization: Bearer` — there is no direct-URL
 * fallback, so a server that isn't registered as a gateway target is simply
 * dropped (with a warning) rather than connected to directly. This makes the
 * gateway's CUSTOM_JWT authorizer + Cedar the single chokepoint for every MCP
 * tool call from this path.
 *
 * `callerAccessToken` is the signed-in user's raw Cognito ACCESS token (see
 * fetchCallerIdentity) — required because `default-gateway`'s CUSTOM_JWT
 * authorizer rejects an ID token with `insufficient_scope` (#327), and Cedar
 * reads `cognito:groups` off that same JWT as a principal tag.
 *
 * `McpServerConfig.headers` (per-server static/OAuth headers, meaningful only
 * for a direct connection) is intentionally not forwarded here — it would be
 * attached to the *gateway* request rather than the downstream MCP server.
 */
async function buildTools(
  mcpServers: McpServerConfig[],
  callerAccessToken: string | null,
): Promise<HarnessTool[] | undefined> {
  if (!mcpServers.length) return undefined;

  const tools: HarnessTool[] = [];
  for (const s of mcpServers) {
    if (!s.gatewayTargetId || !GATEWAY_ENDPOINT) {
      console.warn(
        `[harness-agent] Skipping MCP server "${s.name}" — ${
          GATEWAY_ENDPOINT ? 'no registered gateway target (gatewayTargetId)' : 'GATEWAY_ENDPOINT is not configured'
        }. Gateway routing is mandatory; this server will not be reachable until it is registered as a gateway target (#338).`,
      );
      continue;
    }
    tools.push({
      type: 'remote_mcp',
      name: slugifyToolName(s.name),
      config: {
        remoteMcp: {
          url: GATEWAY_ENDPOINT,
          headers: callerAccessToken ? { Authorization: `Bearer ${callerAccessToken}` } : undefined,
        },
      },
    });
  }

  return tools.length ? tools : undefined;
}

/** Extract the plain text of an AG-UI message (user turns are simple text). */
export function messageText(m: Message): string {
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

  /**
   * True once `refreshHistory()` has set `isRunning = true` itself, from
   * ActiveRun evidence, rather than a local `run()` (issue #451). Lets
   * `refreshHistory()` tell "this tab's own genuine stream, never touch it"
   * apart from "isRunning is true because polling said so, keep polling for
   * when it ends" — both look like `isRunning === true` otherwise.
   */
  private remoteRunActive = false;

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

      // Throttled ActiveRun snapshot: lets a late-joining viewer see the
      // in-flight assistant message before it's persisted to memory. Piggybacks
      // on the AG-UI events we already emit below, rather than re-parsing the
      // raw harness stream — messageId matches TEXT_MESSAGE_START's id so the
      // consumer's dedupe (and the eventual real persist) reconcile cleanly.
      let activeMessageId: string | null = null;
      let accumulatedText = '';
      let activeRunRowId: string | null = null;
      let lastActiveRunWrite = 0;
      const ACTIVE_RUN_THROTTLE_MS = 750;

      (async () => {
        const runId = input.runId || crypto.randomUUID();
        subscriber.next({ type: EventType.RUN_STARTED, threadId: sessionId, runId } as BaseEvent);

        try {
          const { identity: callerIdentity, accessToken: callerAccessToken } = await fetchCallerIdentity();
          const tools = await buildTools(config.mcpServers ?? [], callerAccessToken);

          const response = await client.send(
            new InvokeHarnessCommand({
              harnessArn: HARNESS_ARN,
              runtimeSessionId: sessionId,
              messages: harnessMessages,
              systemPrompt: config.systemPromptText ? [{ text: config.systemPromptText }] : undefined,
              model: config.modelId ? { bedrockModelConfig: { modelId: config.modelId } } : undefined,
              tools,
              runtimeUserId: encodeRuntimeUserId(callerIdentity),
              // Scope all memory ops (events + SUMMARIZATION) for this chat to the
              // signed-in user (issue #256). Falls back to the shared actor when
              // the sub is somehow absent, so an unauthenticated edge never writes
              // to an unreadable namespace. loadHistory dual-reads both.
              actorId: callerIdentity.sub ?? SHARED_ACTOR_ID,
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
              // MCP elicitation (epic #412 slice 4): a -32042 consent-required
              // error from a 3LO gateway target can surface as a stream-level
              // exception rather than a normal tool result, depending on how
              // the harness normalizes it. Detect it here too so it never
              // reaches the user as a raw "run failed: {jsonrpc...}" bubble —
              // surface the elicitation and end the run cleanly instead.
              const elicitation = parseMcpElicitation(ex?.message);
              if (elicitation) {
                for (const aguiEvent of finalizeHarnessStream(streamState)) {
                  subscriber.next(aguiEvent);
                }
                subscriber.next({
                  type: EventType.CUSTOM,
                  name: MCP_ELICITATION_EVENT_NAME,
                  value: elicitation,
                } as BaseEvent);
                for (const aguiEvent of buildRunErrorMessageEvents(
                  elicitationFriendlyMessage(elicitation),
                  () => crypto.randomUUID(),
                )) {
                  subscriber.next(aguiEvent);
                }
                void clearActiveRun(sessionId).catch(() => {});
                subscriber.next({ type: EventType.RUN_FINISHED, threadId: sessionId, runId } as BaseEvent);
                subscriber.complete();
                return;
              }
              throw new Error(ex?.message ?? 'Harness stream exception');
            }
            for (const aguiEvent of translateHarnessStreamEvent(
              event as HarnessStreamEvent,
              streamState,
              () => crypto.randomUUID(),
            )) {
              subscriber.next(aguiEvent);
              if (aguiEvent.type === EventType.TEXT_MESSAGE_START) {
                const id = (aguiEvent as unknown as { messageId: string }).messageId;
                if (id !== activeMessageId) {
                  activeMessageId = id;
                  accumulatedText = '';
                }
              } else if (aguiEvent.type === EventType.TEXT_MESSAGE_CONTENT) {
                accumulatedText += (aguiEvent as unknown as { delta: string }).delta;
              }
            }

            if (activeMessageId && Date.now() - lastActiveRunWrite >= ACTIVE_RUN_THROTTLE_MS) {
              lastActiveRunWrite = Date.now();
              activeRunRowId = await upsertActiveRun(
                { sessionId, messageId: activeMessageId, accumulatedText, status: 'streaming' },
                activeRunRowId,
              );
            }
          }

          if (!cancelled) {
            for (const aguiEvent of finalizeHarnessStream(streamState)) {
              subscriber.next(aguiEvent);
            }
          }

          if (!cancelled && activeMessageId) {
            await upsertActiveRun(
              { sessionId, messageId: activeMessageId, accumulatedText, status: 'streaming' },
              activeRunRowId,
            );
          }
          // The persisted memory version now has the complete message — drop
          // the snapshot so the consumer's `status === 'streaming'` check stops
          // matching and the authoritative copy takes over.
          void clearActiveRun(sessionId).catch(() => {});

          subscriber.next({ type: EventType.RUN_FINISHED, threadId: sessionId, runId } as BaseEvent);
          subscriber.complete();
        } catch (err) {
          void clearActiveRun(sessionId).catch(() => {});
          const name = err instanceof Error ? err.name : undefined;
          if (name === 'AbortError' || cancelled) {
            subscriber.complete();
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          // CopilotChat v2 doesn't render a bare RUN_ERROR event, so a harness
          // failure — most commonly context-window overflow — would otherwise
          // leave the chat showing nothing (issue #243). Emit it as a visible
          // assistant message first, then still surface RUN_ERROR/error() so
          // the run itself is correctly marked failed.
          const displayText = friendlyChatHarnessError(message) ?? `⚠️ The agent run failed: ${message}`;
          for (const aguiEvent of buildRunErrorMessageEvents(displayText, () => crypto.randomUUID())) {
            subscriber.next(aguiEvent);
          }
          subscriber.next({ type: EventType.RUN_ERROR, message } as BaseEvent);
          subscriber.error(err instanceof Error ? err : new Error(message));
        }
      })();

      return () => {
        cancelled = true;
        abort.abort();
        void clearActiveRun(sessionId).catch(() => {});
      };
    });
  }

  /**
   * Stop button wiring: AbstractAgent.abortRun() is a no-op by default, so
   * CopilotChat's built-in Stop button (rendered whenever isRunning is true)
   * would otherwise do nothing. detachActiveRun() unsubscribes the active
   * run's Observable, which runs run()'s teardown below (abort.abort()) and
   * completes the run — no RUN_ERROR, so the partial assistant message is
   * left in place rather than rendered as a failure.
   *
   * When the "responding" state was set by `refreshHistory()`'s ActiveRun
   * detection instead (issue #451 — no local run() is in flight, so there is
   * no Observable to detach), the only actionable "stop" available to this
   * tab is to drop the ActiveRun row: it flips this view back to idle
   * immediately rather than waiting for the row to go stale. It can't reach
   * into whatever tab/webhook runtime is actually producing the turn, so the
   * underlying job keeps running — same limitation InvokeHarness's stream
   * itself has once its originating tab is gone.
   */
  abortRun(): void {
    if (this.remoteRunActive) {
      this.remoteRunActive = false;
      this.isRunning = false;
      const sessionId = this.threadId;
      if (sessionId) void clearActiveRun(sessionId).catch(() => {});
      this.setMessages([...this.messages]);
      return;
    }
    void this.detachActiveRun();
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
   * Issue #451: also mirrors ActiveRun's live/streaming status into `isRunning`
   * itself, so a turn arriving purely through this poll (a webhook run, another
   * tab, or this tab after a reload mid-stream) shows the same "responding"
   * state — Stop button included — as a turn streamed by this tab's own run().
   * `remoteRunActive` distinguishes "isRunning because we set it from polling"
   * from "isRunning because a genuine local run() is in flight", so the guard
   * below only ever skips the latter.
   *
   * Guards keep it safe to run on an interval:
   *  - never touches messages/isRunning while a genuine local run is streaming,
   *    so it can't clobber optimistic/streamed messages not yet persisted.
   *  - only grows the transcript (applies when the fetched set is larger), so a
   *    persistence lag that momentarily returns fewer events can't wipe the
   *    messages the user is currently looking at.
   *
   * Returns the number of messages shown afterwards, for idle-backoff bookkeeping.
   */
  async refreshHistory(): Promise<number> {
    const sessionId = this.threadId;
    if (!sessionId) return this.messages.length;
    if (this.isRunning && !this.remoteRunActive) return this.messages.length;

    const { messages: history, activeRunStreaming } = await loadHistory(sessionId);
    // Re-check: a genuine local run may have started during the async fetch above.
    if (this.isRunning && !this.remoteRunActive) return this.messages.length;

    if (history.length > this.messages.length) {
      this.setMessages(history);
    }

    if (activeRunStreaming !== this.remoteRunActive) {
      this.remoteRunActive = activeRunStreaming;
      this.isRunning = activeRunStreaming;
      // Force a re-render even when the message count didn't change this tick
      // (e.g. the remote run just ended with nothing new persisted yet).
      this.setMessages([...this.messages]);
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
          const { messages } = await loadHistory(sessionId);
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

/** Return shape of loadHistory() — see field docs below. */
export interface HistoryLoadResult {
  messages: Message[];
  /**
   * True when ActiveRun currently reports a live in-flight turn for this
   * session (see isActiveRunStreaming) — read by refreshHistory() to mirror
   * that into `isRunning`/the Stop button (issue #451). Computed here rather
   * than with a second fetchActiveRun() call in the caller.
   */
  activeRunStreaming: boolean;
}

/**
 * Fetch all stored events for a session (paging through the query) and map them
 * to AG-UI messages. Returns the full conversation, including turns that predate
 * a summarization boundary, so the transcript opens on the original user prompt
 * rather than a mid-turn fragment. The Converse→AG-UI parse happens exactly
 * once, in converse-to-agui.ts.
 */
export async function loadHistory(sessionId: string): Promise<HistoryLoadResult> {
  // Dual-read (issue #256, Option A): the signed-in user's own `sub` namespace
  // (where browser harness chats now persist) AND the shared SHARED_ACTOR_ID
  // namespace (where webhook/ClaudeCode/AguiAgent runs persist), so a
  // GitHub-dispatched run still shows up in the chat transcript. The two actors'
  // event sets are disjoint by construction; the sort+dedupe below merges them.
  const { identity } = await fetchCallerIdentity();
  const actorIds = identity.sub && identity.sub !== SHARED_ACTOR_ID
    ? [identity.sub, SHARED_ACTOR_ID]
    : [SHARED_ACTOR_ID];

  const all: StoredEvent[] = [];
  for (const actorId of actorIds) {
    let nextToken: string | null | undefined = null;
    do {
      const result = await dataClient.queries.listSessionMessages({
        sessionId,
        actorId,
        ...(nextToken ? { nextToken } : {}),
      });
      if (result.errors?.length) break;
      for (const e of result.data?.events ?? []) {
        if (e) all.push(e as StoredEvent);
      }
      nextToken = result.data?.nextToken;
    } while (nextToken);
  }

  // Events may be returned in descending order per page. Sort them chronologically
  // (oldest first) before converting to AG-UI messages to ensure correct display order.
  // A missing/unparseable timestamp sorts to the front (treated as oldest).
  const ts = (e: StoredEvent): number => {
    const t = e.timestamp ? new Date(e.timestamp).getTime() : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  const sorted = all.sort((a, b) => ts(a) - ts(b));
  // Every InvokeHarness call forwards the full user/assistant window, and the
  // harness re-persists what it's sent — so the same turn can land as more
  // than one stored event. Collapse those before mapping to AG-UI messages.
  // Convert stored events to AG-UI messages
  const msgs = eventsToAguiMessages(dedupeStoredEvents(sorted));
  // Append in‑flight assistant message from ActiveRun snapshot if present, unless
  // the same turn has already landed in persisted memory (see active-run-merge.ts).
  try {
    const active = await fetchActiveRun(sessionId);
    return { messages: mergeActiveRunSnapshot(msgs, active), activeRunStreaming: isActiveRunStreaming(active) };
  } catch (e) {
    // Log and ignore – history load should succeed even if ActiveRun fetch fails
    console.error('Failed to fetch ActiveRun for session', sessionId, e);
  }
  return { messages: msgs, activeRunStreaming: false };
}
