import {
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable, type Subscriber } from 'rxjs';

import outputs from '../amplify_outputs.json';
import { makeClient, messageText, loadHistory } from './harness-agent';
import { parseInvokeResponseText } from './claude-code-invoke-response';

const custom = (outputs as { custom?: { agentcore_claude_code_runtime_arn?: string } }).custom;
export const CLAUDE_CODE_RUNTIME_ARN = custom?.agentcore_claude_code_runtime_arn as string | undefined;

/** Sentinel agentId value used to select the ClaudeCode runtime in the chat UI's agent picker. */
export const CLAUDE_CODE_AGENT_ID = '__claude_code__';

/**
 * A client-side AG-UI agent backed by the ClaudeCode AgentCore Runtime — the
 * same container agent invoked by the GitHub `@agentcore-claude` webhook
 * (agent/default/app/ClaudeCode), but driven from the chat UI instead.
 *
 * Unlike HarnessAgent, the ClaudeCode runtime is invoked with
 * `InvokeAgentRuntime` (a plain HTTP body request/response, not the harness's
 * optimized Converse event stream) — see agent/default/app/ClaudeCode/server.js's
 * `POST /invocations`. With no `taskToken` in the payload, the runtime runs the
 * `claude` CLI to completion synchronously and returns its final text in the
 * HTTP response body, so `run()` streams that body and emits the result as a
 * single assistant message once the (possibly long-running) job finishes —
 * there is no token-by-token streaming on this path.
 *
 * `runtimeSessionId` is set to the same AgentCore session id used as the AG-UI
 * threadId, so the runtime's workspace clone and AgentCore Memory persistence
 * (agent/default/app/ClaudeCode/memory.js, issue #186) are reused across turns
 * on the same chat session — exactly like a follow-up `@agentcore-claude`
 * comment on the same issue reuses them.
 *
 * `connect()` / `refreshHistory()` read the same stored Converse-shaped memory
 * events HarnessAgent does (via `loadHistory`), since both runtimes write to
 * the same AgentCore Memory in the same shape.
 */
export class ClaudeCodeAgent extends AbstractAgent {
  constructor(opts: { threadId?: string }) {
    super({ agentId: 'default', threadId: opts.threadId });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    const client = makeClient();
    const sessionId = input.threadId || this.threadId || crypto.randomUUID();

    // Only the newest user message needs sending — the runtime persists prior
    // turns to memory itself, and re-sends nothing back for re-injection.
    const lastUserMessage = [...(input.messages ?? [])].reverse().find((m) => m.role === 'user');
    const prompt = lastUserMessage ? messageText(lastUserMessage) : '';

    return new Observable<BaseEvent>((subscriber: Subscriber<BaseEvent>) => {
      const abort = new AbortController();
      let cancelled = false;

      (async () => {
        const runId = input.runId || crypto.randomUUID();
        subscriber.next({ type: EventType.RUN_STARTED, threadId: sessionId, runId } as BaseEvent);

        try {
          if (!CLAUDE_CODE_RUNTIME_ARN) {
            throw new Error('The ClaudeCode runtime is not deployed on this branch (no runtime ARN configured).');
          }

          const payload = { prompt, runId: sessionId };

          const response = await client.send(
            new InvokeAgentRuntimeCommand({
              agentRuntimeArn: CLAUDE_CODE_RUNTIME_ARN,
              // Same id as the AG-UI threadId, so the runtime's workspace clone
              // and memory session are reused across turns on this chat session.
              runtimeSessionId: sessionId,
              contentType: 'application/json',
              accept: 'application/json',
              payload: new TextEncoder().encode(JSON.stringify(payload)),
            }),
            { abortSignal: abort.signal },
          );

          const raw = response.response ? await response.response.transformToString() : '';
          if (cancelled) return;

          if (response.statusCode && response.statusCode >= 400) {
            throw new Error(`ClaudeCode runtime returned HTTP ${response.statusCode}: ${raw.slice(0, 2000)}`);
          }

          const text = parseInvokeResponseText(raw);

          const messageId = crypto.randomUUID();
          subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as BaseEvent);
          if (text) {
            subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text } as BaseEvent);
          }
          subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);

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

  /** Same poll-friendly history refresh as HarnessAgent — see harness-agent.ts for details. */
  async refreshHistory(): Promise<number> {
    if (this.isRunning) return this.messages.length;
    const sessionId = this.threadId;
    if (!sessionId) return this.messages.length;

    const history = await loadHistory(sessionId);
    if (!this.isRunning && history.length > this.messages.length) {
      this.setMessages(history);
    }
    return this.messages.length;
  }

  /** Loads persisted history (shared AgentCore Memory) as a single MESSAGES_SNAPSHOT — see HarnessAgent.connect(). */
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
