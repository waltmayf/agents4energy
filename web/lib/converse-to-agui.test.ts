import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeStoredEvents,
  eventToMessages,
  eventsToAguiMessages,
  messageTimestamp,
  type StoredEvent,
} from './converse-to-agui.ts';

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

// Issue #451: the "most recent message" timestamp UI reads this field off
// every message — verify it's actually attached, for both the plain-text
// fallback path and the structured contentJson path.
test('a stored event timestamp is attached to the plain-text fallback message', () => {
  const msgs = eventToMessages({ role: 'user', text: 'hello', timestamp: '2026-08-20T12:00:00.000Z' }, 0);
  assert.equal(msgs.length, 1);
  assert.equal(messageTimestamp(msgs[0]), '2026-08-20T12:00:00.000Z');
});

test('a stored event timestamp is attached to a structured-content message', () => {
  const ev = stored('assistant', [{ text: 'the answer is 42' }]);
  ev.timestamp = '2026-08-20T12:05:00.000Z';
  const msgs = eventToMessages(ev, 0);
  assert.equal(msgs.length, 1);
  assert.equal(messageTimestamp(msgs[0]), '2026-08-20T12:05:00.000Z');
});

test('a missing timestamp is left unset rather than defaulting to something', () => {
  const msgs = eventToMessages({ role: 'user', text: 'hello' }, 0);
  assert.equal(messageTimestamp(msgs[0]), undefined);
});

test('assistant text block becomes one assistant message', () => {
  const msgs = eventToMessages(stored('assistant', [{ text: 'the answer is 42' }]), 0);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal((msgs[0] as { content: string }).content, 'the answer is 42');
});

test('multiple text blocks in one assistant turn are separated, not glued together (#244)', () => {
  const msgs = eventToMessages(
    stored('assistant', [
      { text: "I'll check what's actually available in this container before concluding anything." },
      { text: 'I do have root and network access, so let me actually try installing them rather than assuming I can\'t.' },
    ]),
    0,
  );
  assert.equal(msgs.length, 1);
  const content = (msgs[0] as { content: string }).content;
  assert.match(content, /anything\.\s+I do have root/);
  assert.ok(!content.includes('anything.I do have root'), 'text blocks must not be joined with no separator');
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

test('built-in tool call leaked as flattened text reconstructs a degraded tool card (#117)', () => {
  // The exact shape from issue #117: no contentJson on either event, the
  // assistant turn leaks "functions.shell", and the following user turn is a
  // bare JSON tool-result object.
  const events: StoredEvent[] = [
    {
      eventId: 'a',
      role: 'assistant',
      text: 'We need to run a shell command using the provided function. Use functions.shell.',
    },
    {
      eventId: 'b',
      role: 'user',
      text: '{"stdout": "HELLO_FROM_SHELL_42\\n", "stderr": "", "exit_code": 0}',
    },
    {
      eventId: 'c',
      role: 'assistant',
      text: 'The command executed successfully.\n\n**Output**\n\n```\nHELLO_FROM_SHELL_42\n```',
    },
  ];
  const msgs = eventsToAguiMessages(events);

  const toolCallMsg = msgs.find(
    (m) => m.role === 'assistant' && (m as { toolCalls?: unknown[] }).toolCalls?.length,
  ) as { toolCalls: Array<{ id: string; function: { name: string } }> };
  assert.ok(toolCallMsg, 'expected a reconstructed assistant tool-call message');
  assert.equal(toolCallMsg.toolCalls[0].function.name, 'shell');

  const toolMsg = msgs.find((m) => m.role === 'tool') as { toolCallId: string; content: string };
  assert.ok(toolMsg, 'expected a reconstructed tool-result message');
  assert.equal(toolMsg.toolCallId, toolCallMsg.toolCalls[0].id);
  assert.match(toolMsg.content, /HELLO_FROM_SHELL_42/);

  // The user's raw JSON never survives as a plain "user" bubble.
  assert.ok(!msgs.some((m) => m.role === 'user'), 'raw tool-result JSON should not render as a user message');

  // The final assistant summary still renders normally.
  const finalMsg = msgs[msgs.length - 1] as { role: string; content: string };
  assert.equal(finalMsg.role, 'assistant');
  assert.match(finalMsg.content, /executed successfully/);
});

test('a genuine user message containing "functions." text is left untouched', () => {
  // Guard against false positives: ordinary prose mentioning "functions.foo"
  // followed by a real user JSON message should not be misread as a leaked
  // tool-call pair.
  const events: StoredEvent[] = [
    { eventId: 'a', role: 'assistant', text: 'You can call functions.shell yourself if you want.' },
    { eventId: 'b', role: 'user', text: 'no thanks, {"note": "just chatting"}' },
  ];
  const msgs = eventsToAguiMessages(events);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[1].role, 'user');
});

test('dedupeStoredEvents collapses the #116 fixture to 2 real user turns in send-order', () => {
  // The exact scenario from #116: two user turns were sent ("...ABC12" then
  // "...XYZ99"), but re-forwarding the full window on each InvokeHarness call
  // caused the harness to re-persist turns already in memory. After sorting
  // chronologically (loadHistory's job, not this test's), the 6 stored events
  // are: turn 1 (user + assistant, each persisted twice) followed by turn 2
  // (user once, assistant once — no third invoke happened yet to re-persist it).
  const events: StoredEvent[] = [
    { eventId: 'u1', role: 'user', text: 'Reply with exactly the token ABC12', timestamp: '2026-07-28T10:00:00.000Z' },
    { eventId: 'u1-dup', role: 'user', text: 'Reply with exactly the token ABC12', timestamp: '2026-07-28T10:00:01.000Z' },
    { eventId: 'a1', role: 'assistant', text: 'User asks: Reply with exactly the token ABC12', timestamp: '2026-07-28T10:00:02.000Z' },
    { eventId: 'a1-dup', role: 'assistant', text: 'User asks: Reply with exactly the token ABC12', timestamp: '2026-07-28T10:00:03.000Z' },
    { eventId: 'u2', role: 'user', text: 'Reply with exactly the token XYZ99', timestamp: '2026-07-28T10:05:00.000Z' },
    { eventId: 'a2', role: 'assistant', text: 'User wants token XYZ99 exactly', timestamp: '2026-07-28T10:05:01.000Z' },
  ];

  const deduped = dedupeStoredEvents(events);

  assert.equal(deduped.length, 4);
  assert.deepEqual(deduped.map((e) => e.eventId), ['u1', 'a1', 'u2', 'a2']);

  const msgs = eventsToAguiMessages(deduped);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[2].role, 'user');
  assert.equal(msgs[3].role, 'assistant');
});

test('dedupeStoredEvents preserves a genuinely repeated user message sent minutes apart', () => {
  // A user can legitimately send the identical text twice as two distinct
  // turns (e.g. re-asking the same question later). Only collapse duplicates
  // that land within the re-persist window, not ones far apart in time.
  const events: StoredEvent[] = [
    { eventId: 'u1', role: 'user', text: 'ping', timestamp: '2026-07-28T10:00:00.000Z' },
    { eventId: 'a1', role: 'assistant', text: 'pong', timestamp: '2026-07-28T10:00:01.000Z' },
    { eventId: 'u2', role: 'user', text: 'ping', timestamp: '2026-07-28T10:10:00.000Z' },
    { eventId: 'a2', role: 'assistant', text: 'pong again', timestamp: '2026-07-28T10:10:01.000Z' },
  ];

  const deduped = dedupeStoredEvents(events);

  assert.equal(deduped.length, 4);
  assert.deepEqual(deduped.map((e) => e.eventId), ['u1', 'a1', 'u2', 'a2']);
});

test('dedupeStoredEvents dedupes structured (contentJson) events by exact block content', () => {
  const events: StoredEvent[] = [
    stored('assistant', [{ toolUse: { toolUseId: 't1', name: 'lookup', input: { q: 'x' } } }], 'a1'),
    { ...stored('assistant', [{ toolUse: { toolUseId: 't1', name: 'lookup', input: { q: 'x' } } }], 'a1-dup') },
    stored('user', [{ toolResult: { toolUseId: 't1', content: [{ text: 'result' }] } }], 'b1'),
  ];
  // Give them timestamps within the re-persist window.
  events[0].timestamp = '2026-07-28T10:00:00.000Z';
  events[1].timestamp = '2026-07-28T10:00:00.500Z';
  events[2].timestamp = '2026-07-28T10:00:01.000Z';

  const deduped = dedupeStoredEvents(events);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((e) => e.eventId), ['a1', 'b1']);
});
