import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventType } from '@ag-ui/client';
import { buildRunErrorMessageEvents } from './harness-run-error.ts';
import { friendlyChatHarnessError } from './harness-error-message.ts';

test('renders a context-overflow RUN_ERROR as a visible assistant message suggesting a new session', () => {
  const rawMessage =
    'An error occurred (ValidationException) when calling the ConverseStream operation: ' +
    "Input length (272468) exceeds model's maximum context length (131072).";
  const displayText = friendlyChatHarnessError(rawMessage) ?? `⚠️ The agent run failed: ${rawMessage}`;
  let n = 0;
  const events = buildRunErrorMessageEvents(displayText, () => `gen-${n++}`);

  assert.deepEqual(events.map((e) => e.type), [
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
  ]);

  const start = events[0] as unknown as { messageId: string; role: string };
  const content = events[1] as unknown as { messageId: string; delta: string };
  const end = events[2] as unknown as { messageId: string };
  assert.equal(start.role, 'assistant');
  assert.equal(start.messageId, content.messageId);
  assert.equal(start.messageId, end.messageId);

  assert.match(content.delta, /context window overflowed/);
  assert.match(content.delta, /272,468/);
  assert.match(content.delta, /131,072/);
  assert.match(content.delta, /start a new chat session/i);
  assert.doesNotMatch(content.delta, /ValidationException|ConverseStream/);
});

test('falls back to a generic visible message for an unrecognized error', () => {
  const rawMessage = 'some transient network blip';
  const displayText = friendlyChatHarnessError(rawMessage) ?? `⚠️ The agent run failed: ${rawMessage}`;
  const events = buildRunErrorMessageEvents(displayText, () => 'id-1');
  const content = events[1] as unknown as { delta: string };
  assert.match(content.delta, /agent run failed/i);
  assert.match(content.delta, /some transient network blip/);
});
