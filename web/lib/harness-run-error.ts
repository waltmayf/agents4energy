import { EventType, type BaseEvent } from '@ag-ui/client';

/**
 * Builds the AG-UI events needed to render a harness run failure as a visible
 * assistant chat bubble (issue #243). CopilotChat v2 doesn't render a bare
 * RUN_ERROR event, so without this a harness failure — most commonly
 * context-window overflow once a session's replayed transcript exceeds the
 * model's limit — leaves the chat showing nothing at all.
 */
export function buildRunErrorMessageEvents(displayText: string, genId: () => string): BaseEvent[] {
  const messageId = genId();
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: displayText } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent,
  ];
}
