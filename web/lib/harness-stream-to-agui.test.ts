import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventType, type BaseEvent } from '@ag-ui/client';
import {
  createHarnessStreamState,
  translateHarnessStreamEvent,
  finalizeHarnessStream,
  type HarnessStreamEvent,
} from './harness-stream-to-agui.ts';

/**
 * Run a full harness stream through the translator with a deterministic id
 * generator, returning the flattened AG-UI event log (plus finalize output).
 */
function run(events: HarnessStreamEvent[]): BaseEvent[] {
  const state = createHarnessStreamState();
  let n = 0;
  const genId = () => `gen-${n++}`;
  const out: BaseEvent[] = [];
  for (const ev of events) out.push(...translateHarnessStreamEvent(ev, state, genId));
  out.push(...finalizeHarnessStream(state));
  return out;
}

const types = (evs: BaseEvent[]) => evs.map((e) => e.type);

test('text-only turn emits START / CONTENT / END', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' world' } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'end_turn' } },
  ]);
  assert.deepEqual(types(evs), [
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
  ]);
  const contents = evs
    .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((e) => (e as unknown as { delta: string }).delta);
  assert.deepEqual(contents, ['Hello', ' world']);
});

test('toolUse block emits TOOL_CALL_START / ARGS / END with the harness id', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    {
      contentBlockStart: {
        contentBlockIndex: 0,
        start: { toolUse: { toolUseId: 'tool-xyz', name: 'get_weather' } },
      },
    },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"NYC"}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: 'tool_use' } },
  ]);
  assert.deepEqual(types(evs), [
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
  ]);
  const start = evs[0] as unknown as { toolCallId: string; toolCallName: string; parentMessageId?: string };
  assert.equal(start.toolCallId, 'tool-xyz');
  assert.equal(start.toolCallName, 'get_weather');
  // The tool call is parented to the assistant turn message.
  assert.equal(start.parentMessageId, 'gen-0');
  const args = evs
    .filter((e) => e.type === EventType.TOOL_CALL_ARGS)
    .map((e) => (e as unknown as { delta: string }).delta)
    .join('');
  assert.deepEqual(JSON.parse(args), { city: 'NYC' });
  // Every tool-call event carries the same id.
  for (const e of evs) {
    assert.equal((e as unknown as { toolCallId: string }).toolCallId, 'tool-xyz');
  }
});

test('text followed by a tool call closes the text message first', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'let me check' } } },
    {
      contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 't1', name: 'q' } } },
    },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{}' } } } },
    { contentBlockStop: { contentBlockIndex: 1 } },
  ]);
  assert.deepEqual(types(evs), [
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END, // closed before the tool call starts
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
  ]);
});

test('toolResult block emits a TOOL_CALL_RESULT linked by toolCallId', () => {
  const evs = run([
    { messageStart: { role: 'user' } },
    {
      contentBlockStart: { contentBlockIndex: 0, start: { toolResult: { toolUseId: 't1', status: 'success' } } },
    },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: 'sunny' }] } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ json: { temp: 75 } }] } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
  ]);
  assert.deepEqual(types(evs), [EventType.TOOL_CALL_RESULT]);
  const result = evs[0] as unknown as { toolCallId: string; content: string; role: string };
  assert.equal(result.toolCallId, 't1');
  assert.equal(result.role, 'tool');
  assert.equal(result.content, 'sunny{"temp":75}');
});

test('interleaved tool-use blocks are attributed by contentBlockIndex', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'A', name: 'a' } } } },
    { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'B', name: 'b' } } } },
    { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"b":1}' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"a":1}' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { contentBlockStop: { contentBlockIndex: 1 } },
  ]);
  const argsFor = (id: string) =>
    evs
      .filter((e) => e.type === EventType.TOOL_CALL_ARGS && (e as unknown as { toolCallId: string }).toolCallId === id)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join('');
  assert.equal(argsFor('A'), '{"a":1}');
  assert.equal(argsFor('B'), '{"b":1}');
});

test('finalize closes an unterminated text message', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'no stop event' } } },
    // stream ends without contentBlockStop / messageStop
  ]);
  assert.equal(evs[evs.length - 1].type, EventType.TEXT_MESSAGE_END);
});

test('finalize closes an unterminated tool call', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't1', name: 'q' } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } },
    // stream ends without a stop
  ]);
  assert.equal(evs[evs.length - 1].type, EventType.TOOL_CALL_END);
  assert.equal((evs[evs.length - 1] as unknown as { toolCallId: string }).toolCallId, 't1');
});

test('toolUse with a missing id falls back to a generated id', () => {
  const evs = run([
    { messageStart: { role: 'assistant' } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'q' } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
  ]);
  const start = evs[0] as unknown as { toolCallId: string };
  assert.match(start.toolCallId, /^gen-/);
  // START and END share the generated id.
  assert.equal((evs[1] as unknown as { toolCallId: string }).toolCallId, start.toolCallId);
});
