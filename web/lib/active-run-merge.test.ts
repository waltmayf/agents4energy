import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActiveRunStreaming, mergeActiveRunSnapshot, type ActiveRunSnapshot } from './active-run-merge.ts';
import type { Message } from '@ag-ui/client';

function assistantMsg(id: string, content: string): Message {
  return { id, role: 'assistant', content } as Message;
}

test('returns msgs unchanged when there is no active run', () => {
  const msgs = [assistantMsg('e1', 'hello')];
  assert.deepEqual(mergeActiveRunSnapshot(msgs, null), msgs);
});

test('returns msgs unchanged when status is not streaming', () => {
  const msgs = [assistantMsg('e1', 'hello')];
  const active: ActiveRunSnapshot = {
    status: 'done',
    accumulatedText: 'ZXQ42',
    messageId: 'client-uuid-1',
    updatedAt: new Date().toISOString(),
  };
  assert.deepEqual(mergeActiveRunSnapshot(msgs, active), msgs);
});

test('appends the in-flight snapshot when no persisted message matches its text', () => {
  const msgs = [assistantMsg('e1', 'ABC12')];
  const active: ActiveRunSnapshot = {
    status: 'streaming',
    accumulatedText: 'still thinking...',
    messageId: 'client-uuid-1',
    updatedAt: new Date().toISOString(),
  };
  const result = mergeActiveRunSnapshot(msgs, active);
  assert.equal(result.length, 2);
  assert.equal(result[1].id, 'client-uuid-1');
});

// This is the #242 regression: the ActiveRun snapshot's messageId (a client-generated
// crypto.randomUUID()) never matches a persisted event's eventId, so an id-based dedup
// guard never fires. Once the harness's run has persisted the turn to AgentCore memory,
// a poll landing before clearActiveRun's fire-and-forget delete completes must not
// duplicate it — this is asserted purely by text content, independent of any id scheme.
test('#242: does not duplicate a turn already present in persisted history, despite mismatched ids', () => {
  const msgs = [assistantMsg('persisted-event-id-xyz', 'XYZ99')];
  const active: ActiveRunSnapshot = {
    status: 'streaming', // stale row: clearActiveRun() hasn't landed yet
    accumulatedText: 'XYZ99',
    messageId: 'client-generated-uuid-does-not-match-eventId',
    updatedAt: new Date().toISOString(),
  };
  const result = mergeActiveRunSnapshot(msgs, active);
  assert.equal(result.length, 1, 'the persisted XYZ99 turn must render exactly once');
});

test('#242: matches even when persisted text has extra whitespace/join separators (#244 joins with "\\n\\n")', () => {
  const msgs = [assistantMsg('persisted-event-id', 'Part one.\n\nPart two XYZ99.')];
  const active: ActiveRunSnapshot = {
    status: 'streaming',
    accumulatedText: 'Part one.Part two XYZ99.', // raw streamed text had no separator
    messageId: 'client-uuid',
    updatedAt: new Date().toISOString(),
  };
  const result = mergeActiveRunSnapshot(msgs, active);
  assert.equal(result.length, 1);
});

test('ignores a stale snapshot (no one left to clear it after a crashed browser)', () => {
  const msgs: Message[] = [];
  const active: ActiveRunSnapshot = {
    status: 'streaming',
    accumulatedText: 'stuck forever',
    messageId: 'client-uuid',
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  };
  assert.deepEqual(mergeActiveRunSnapshot(msgs, active), msgs);
});

test('ignores a snapshot with empty accumulatedText', () => {
  const msgs: Message[] = [];
  const active: ActiveRunSnapshot = {
    status: 'streaming',
    accumulatedText: '   ',
    messageId: 'client-uuid',
    updatedAt: new Date().toISOString(),
  };
  assert.deepEqual(mergeActiveRunSnapshot(msgs, active), msgs);
});

// Issue #451: refreshHistory() uses isActiveRunStreaming() to mirror ActiveRun's
// status into the chat's "responding" state (isRunning) while polling.
test('isActiveRunStreaming: true for a fresh streaming row', () => {
  assert.equal(
    isActiveRunStreaming({ status: 'streaming', updatedAt: new Date().toISOString() }),
    true,
  );
});

test('isActiveRunStreaming: false when there is no row', () => {
  assert.equal(isActiveRunStreaming(null), false);
});

test('isActiveRunStreaming: false once status is no longer streaming', () => {
  assert.equal(isActiveRunStreaming({ status: 'done', updatedAt: new Date().toISOString() }), false);
});

test('isActiveRunStreaming: false for a stale row (crashed browser, #451/#242)', () => {
  assert.equal(
    isActiveRunStreaming({ status: 'streaming', updatedAt: new Date(Date.now() - 120_000).toISOString() }),
    false,
  );
});

test("the synthetic in-flight message carries the ActiveRun row's updatedAt as its timestamp", () => {
  const updatedAt = new Date().toISOString();
  const active: ActiveRunSnapshot = {
    status: 'streaming',
    accumulatedText: 'still thinking...',
    messageId: 'client-uuid-1',
    updatedAt,
  };
  const result = mergeActiveRunSnapshot([], active);
  assert.equal(result.length, 1);
  assert.equal((result[0] as unknown as { timestamp?: string }).timestamp, updatedAt);
});
