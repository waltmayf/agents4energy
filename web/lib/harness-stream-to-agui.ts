import { EventType, type BaseEvent } from '@ag-ui/client';

/**
 * Translates the AgentCore Harness's live Bedrock Converse event stream into
 * AG-UI events. This is the LIVE counterpart to converse-to-agui.ts (which
 * handles the reload/MESSAGES_SNAPSHOT path):
 *
 *   - text deltas          → TEXT_MESSAGE_START / _CONTENT / _END
 *   - toolUse block         → TOOL_CALL_START / _ARGS / _END
 *   - toolResult block      → TOOL_CALL_RESULT
 *
 * Without this, a live turn only emits text and tool activity is silently
 * dropped — so tool cards only appear after a reload rebuilds them from memory.
 *
 * The Converse stream is block-oriented: each content block has a stable
 * `contentBlockIndex`; a block is opened by `contentBlockStart`, streamed via
 * `contentBlockDelta`, and closed by `contentBlockStop`. Text blocks carry no
 * `start`, so we open the text message lazily on the first text delta. toolUse
 * and toolResult blocks announce their ids in `start`, which we key by index so
 * later deltas can be attributed to the right tool call.
 */

/** A loosely-typed harness stream event (union: exactly one key is present). */
export interface HarnessStreamEvent {
  messageStart?: { role?: string };
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: {
      toolUse?: { toolUseId?: string; name?: string };
      toolResult?: { toolUseId?: string; status?: string };
    };
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: {
      text?: string;
      toolUse?: { input?: string };
      toolResult?: Array<{ text?: string; json?: unknown }>;
      reasoningContent?: { text?: string };
    };
  };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: string };
}

/** Mutable state threaded through a single InvokeHarness stream. */
export interface HarnessStreamState {
  /** The current assistant message id (groups text + tool calls of one turn). */
  turnMessageId: string | null;
  /** Whether a TEXT_MESSAGE_START has been emitted for the current turn. */
  textStarted: boolean;
  /** contentBlockIndex → toolCallId for open toolUse blocks. */
  toolBlocks: Map<number, string>;
  /** contentBlockIndex → accumulating toolResult, keyed by toolCallId. */
  resultBlocks: Map<number, { toolCallId: string; parts: string[] }>;
}

export function createHarnessStreamState(): HarnessStreamState {
  return {
    turnMessageId: null,
    textStarted: false,
    toolBlocks: new Map(),
    resultBlocks: new Map(),
  };
}

/** Serialize one toolResult delta part (text or JSON document) to a string. */
function resultPartText(part: { text?: string; json?: unknown }): string {
  if (typeof part?.text === 'string') return part.text;
  if (part?.json != null) {
    try {
      return JSON.stringify(part.json);
    } catch {
      return '';
    }
  }
  return '';
}

/** Close the open assistant text message, if any. */
function endText(state: HarnessStreamState, out: BaseEvent[]): void {
  if (state.textStarted && state.turnMessageId) {
    out.push({ type: EventType.TEXT_MESSAGE_END, messageId: state.turnMessageId } as BaseEvent);
    state.textStarted = false;
  }
}

/**
 * Translate a single harness stream event into zero or more AG-UI events,
 * mutating `state`. `genId` produces ids for messages/results (injectable so
 * tests stay deterministic).
 */
export function translateHarnessStreamEvent(
  event: HarnessStreamEvent,
  state: HarnessStreamState,
  genId: () => string,
): BaseEvent[] {
  const out: BaseEvent[] = [];

  // A new assistant turn resets the message grouping. Tool-result turns arrive
  // under role 'user' (the tool speaking back); we don't open a text message
  // for those — their TOOL_CALL_RESULT carries role 'tool'.
  if (event.messageStart) {
    if (event.messageStart.role === 'assistant') {
      endText(state, out);
      state.turnMessageId = genId();
      state.textStarted = false;
    }
    return out;
  }

  if (event.contentBlockStart) {
    const idx = event.contentBlockStart.contentBlockIndex ?? 0;
    const start = event.contentBlockStart.start;
    if (start?.toolUse) {
      // A tool call ends any in-progress assistant text so the transcript reads
      // text → tool activity.
      endText(state, out);
      const toolCallId = start.toolUse.toolUseId ?? genId();
      state.toolBlocks.set(idx, toolCallId);
      const parentMessageId = state.turnMessageId ?? undefined;
      out.push({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: start.toolUse.name ?? 'tool',
        ...(parentMessageId ? { parentMessageId } : {}),
      } as BaseEvent);
    } else if (start?.toolResult) {
      state.resultBlocks.set(idx, {
        toolCallId: start.toolResult.toolUseId ?? genId(),
        parts: [],
      });
    }
    return out;
  }

  if (event.contentBlockDelta) {
    const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
    const delta = event.contentBlockDelta.delta;
    if (typeof delta?.text === 'string' && delta.text) {
      if (!state.turnMessageId) state.turnMessageId = genId();
      if (!state.textStarted) {
        out.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: state.turnMessageId,
          role: 'assistant',
        } as BaseEvent);
        state.textStarted = true;
      }
      out.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: state.turnMessageId,
        delta: delta.text,
      } as BaseEvent);
    } else if (delta?.toolUse) {
      const toolCallId = state.toolBlocks.get(idx);
      if (toolCallId && typeof delta.toolUse.input === 'string' && delta.toolUse.input) {
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: delta.toolUse.input,
        } as BaseEvent);
      }
    } else if (Array.isArray(delta?.toolResult)) {
      const block = state.resultBlocks.get(idx);
      if (block) {
        for (const part of delta.toolResult) block.parts.push(resultPartText(part));
      }
    }
    // reasoningContent deltas are intentionally ignored live for now.
    return out;
  }

  if (event.contentBlockStop) {
    const idx = event.contentBlockStop.contentBlockIndex ?? 0;
    const toolCallId = state.toolBlocks.get(idx);
    if (toolCallId) {
      out.push({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
      state.toolBlocks.delete(idx);
      return out;
    }
    const result = state.resultBlocks.get(idx);
    if (result) {
      out.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: genId(),
        toolCallId: result.toolCallId,
        content: result.parts.join(''),
        role: 'tool',
      } as BaseEvent);
      state.resultBlocks.delete(idx);
      return out;
    }
    // Text block stop: close the assistant text message.
    endText(state, out);
    return out;
  }

  return out;
}

/**
 * Flush any still-open text message / tool calls at the end of the stream so
 * the AG-UI event log is well-formed even if the harness omits stop events.
 */
export function finalizeHarnessStream(state: HarnessStreamState): BaseEvent[] {
  const out: BaseEvent[] = [];
  endText(state, out);
  for (const toolCallId of state.toolBlocks.values()) {
    out.push({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
  }
  state.toolBlocks.clear();
  state.resultBlocks.clear();
  return out;
}
