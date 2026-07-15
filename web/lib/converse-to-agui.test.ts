import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventToMessages, eventsToAguiMessages, type StoredEvent } from './converse-to-agui.ts';

/** Build a StoredEvent whose contentJson is a Converse ContentBlock[]. */
function stored(role: string, blocks: unknown[], eventId = 'e1'): StoredEvent {
  return { eventId, role, contentJson: JSON.stringify(blocks) };
}

test('plain text falls back to a single message when no contentJson', () => {
  const msgs = eventToMessages({ role: 'user', text: 'hello' }, 0);
  assert.deepEqual(msgs, [{ id: 'msg-0', role: 'user', content: 'hello' }]);
});

test('empty text with no blocks produces no messages', () => {
  assert.deepEqual(eventToMessages({ role: 'assistant', text: '   ' }, 0), []);
});

test('assistant text block becomes one assistant message', () => {
  const msgs = eventToMessages(stored('assistant', [{ text: 'the answer is 42' }]), 0);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal((msgs[0] as { content: string }).content, 'the answer is 42');
});

test('assistant toolUse produces an assistant message carrying toolCalls', () => {
  const msgs = eventToMessages(
    stored('assistant', [
      { text: 'let me check' },
      { toolUse: { toolUseId: 'tool-abc', name: 'get_weather', input: { city: 'NYC' } } },
    ]),
    0,
  );
  // One assistant message: text + toolCalls attached.
  const assistant = msgs.find((m) => m.role === 'assistant') as {
    content?: string;
    toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  };
  assert.ok(assistant, 'expected an assistant message');
  assert.equal(assistant.content, 'let me check');
  assert.equal(assistant.toolCalls?.length, 1);
  const call = assistant.toolCalls![0];
  assert.equal(call.id, 'tool-abc');
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'get_weather');
  // Converse input object → AG-UI JSON string.
  assert.deepEqual(JSON.parse(call.function.arguments), { city: 'NYC' });
});

test('toolUse with no text still attaches toolCalls to an assistant message', () => {
  const msgs = eventToMessages(
    stored('assistant', [{ toolUse: { toolUseId: 't1', name: 'search', input: { q: 'x' } } }]),
    0,
  );
  const assistant = msgs.find((m) => m.role === 'assistant') as { toolCalls?: unknown[] };
  assert.ok(assistant, 'expected an assistant message even without text');
  assert.equal(assistant.toolCalls?.length, 1);
});

test('toolResult becomes a linked tool message', () => {
  const msgs = eventToMessages(
    stored('user', [
      { toolResult: { toolUseId: 'tool-abc', status: 'success', content: [{ text: 'sunny, 75F' }] } },
    ]),
    0,
  );
  const toolMsg = msgs.find((m) => m.role === 'tool') as {
    toolCallId: string;
    content: string;
    error?: string;
  };
  assert.ok(toolMsg, 'expected a tool message');
  assert.equal(toolMsg.toolCallId, 'tool-abc');
  assert.equal(toolMsg.content, 'sunny, 75F');
  assert.equal(toolMsg.error, undefined);
});

test('toolResult content supports json parts and joins multiple parts', () => {
  const msgs = eventToMessages(
    stored('user', [
      { toolResult: { toolUseId: 't1', content: [{ text: 'line1' }, { json: { ok: true } }] } },
    ]),
    0,
  );
  const toolMsg = msgs.find((m) => m.role === 'tool') as { content: string };
  assert.equal(toolMsg.content, 'line1\n{"ok":true}');
});

test('error toolResult sets the error field', () => {
  const msgs = eventToMessages(
    stored('user', [{ toolResult: { toolUseId: 't1', status: 'error', content: [{ text: 'boom' }] } }]),
    0,
  );
  const toolMsg = msgs.find((m) => m.role === 'tool') as { error?: string };
  assert.equal(toolMsg.error, 'boom');
});

test('reasoningContent becomes its own reasoning message', () => {
  const msgs = eventToMessages(
    stored('assistant', [
      { reasoningContent: { reasoningText: { text: 'thinking...' } } },
      { text: 'done' },
    ]),
    0,
  );
  const reasoning = msgs.find((m) => m.role === 'reasoning') as { content: string };
  assert.ok(reasoning, 'expected a reasoning message');
  assert.equal(reasoning.content, 'thinking...');
  // Reasoning is ordered before the answer.
  assert.ok(
    msgs.findIndex((m) => m.role === 'reasoning') < msgs.findIndex((m) => m.role === 'assistant'),
    'reasoning should precede the assistant answer',
  );
});

test('inline <reasoning> tags are split out of assistant text', () => {
  const msgs = eventToMessages(
    stored('assistant', [{ text: '<reasoning>let me think</reasoning>The result is 7.' }]),
    0,
  );
  const reasoning = msgs.find((m) => m.role === 'reasoning') as { content: string };
  const assistant = msgs.find((m) => m.role === 'assistant') as { content: string };
  assert.equal(reasoning?.content, 'let me think');
  assert.equal(assistant?.content, 'The result is 7.');
});

test('unclosed inline <reasoning> is captured', () => {
  const msgs = eventToMessages(stored('assistant', [{ text: '<reasoning>still going' }]), 0);
  const reasoning = msgs.find((m) => m.role === 'reasoning') as { content: string };
  assert.equal(reasoning?.content, 'still going');
  // No answer text remains, so no assistant message.
  assert.equal(msgs.find((m) => m.role === 'assistant'), undefined);
});

test('malformed contentJson falls back to flattened text', () => {
  const msgs = eventToMessages({ role: 'assistant', contentJson: '{not json', text: 'fallback' }, 0);
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0] as { content: string }).content, 'fallback');
});

test('full round-trip: assistant toolUse then tool result across events', () => {
  const events: StoredEvent[] = [
    stored('assistant', [{ text: 'checking' }, { toolUse: { toolUseId: 'tc1', name: 'lookup', input: {} } }], 'a'),
    stored('user', [{ toolResult: { toolUseId: 'tc1', content: [{ text: 'found it' }] } }], 'b'),
  ];
  const msgs = eventsToAguiMessages(events);
  const assistant = msgs.find((m) => m.role === 'assistant') as {
    toolCalls?: Array<{ id: string }>;
  };
  const toolMsg = msgs.find((m) => m.role === 'tool') as { toolCallId: string };
  // The tool call id links the assistant call to its result.
  assert.equal(assistant.toolCalls?.[0].id, 'tc1');
  assert.equal(toolMsg.toolCallId, 'tc1');
  // The assistant message (with the call) precedes the tool result.
  assert.ok(
    msgs.findIndex((m) => m.role === 'assistant') < msgs.findIndex((m) => m.role === 'tool'),
  );
});
