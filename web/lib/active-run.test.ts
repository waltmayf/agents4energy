import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * In-memory fake of the ActiveRun model's Amplify Data client calls, just
 * enough surface for upsertActiveRun/clearActiveRun to exercise their
 * create-vs-update branching without a real backend.
 */
function makeFakeModel() {
  let rows: Array<{ id: string; sessionId: string; messageId: string; accumulatedText: string; status: string; updatedAt: string }> = [];
  let nextId = 1;
  const calls: { create: number; update: number; delete: number; list: number } = {
    create: 0,
    update: 0,
    delete: 0,
    list: 0,
  };

  const ActiveRun = {
    // Mirrors the generated sessionId-GSI query field (chat.schema.ts).
    listActiveRunBySession: async ({ sessionId }: { sessionId: string }) => {
      calls.list++;
      const data = rows.filter((r) => r.sessionId === sessionId);
      return { data, errors: undefined };
    },
    create: async (input: { sessionId: string; messageId: string; accumulatedText: string; status: string; updatedAt: string }) => {
      calls.create++;
      const row = { id: `row-${nextId++}`, ...input };
      rows.push(row);
      return { data: row, errors: undefined };
    },
    update: async (input: { id: string; messageId: string; accumulatedText: string; status: string; updatedAt: string }) => {
      calls.update++;
      const row = rows.find((r) => r.id === input.id);
      if (!row) return { data: undefined, errors: [{ message: 'not found' }] };
      Object.assign(row, input);
      return { data: row, errors: undefined };
    },
    delete: async ({ id }: { id: string }) => {
      calls.delete++;
      rows = rows.filter((r) => r.id !== id);
      return { data: { id }, errors: undefined };
    },
    get: async ({ id }: { id: string }) => ({ data: rows.find((r) => r.id === id) ?? null, errors: undefined }),
  };

  return { models: { ActiveRun }, calls, rows: () => rows };
}

const fake = makeFakeModel();

mock.module('aws-amplify/data', {
  namedExports: {
    generateClient: () => fake,
  },
});

const { upsertActiveRun, clearActiveRun, fetchActiveRun } = await import('./active-run.ts');

test('upsertActiveRun creates a row when none exists for the session', async () => {
  const id = await upsertActiveRun({
    sessionId: 'session-1',
    messageId: 'msg-1',
    accumulatedText: 'Hello',
    status: 'streaming',
  });

  assert.ok(id);
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.calls.update, 0);
  const row = fake.rows().find((r) => r.sessionId === 'session-1');
  assert.equal(row?.accumulatedText, 'Hello');
  assert.equal(row?.status, 'streaming');
});

test('upsertActiveRun updates by id on a later throttled write, no re-list', async () => {
  const id = await upsertActiveRun({
    sessionId: 'session-2',
    messageId: 'msg-2',
    accumulatedText: 'First',
    status: 'streaming',
  });
  assert.ok(id);

  const listCallsBefore = fake.calls.list;
  const id2 = await upsertActiveRun(
    { sessionId: 'session-2', messageId: 'msg-2', accumulatedText: 'First and second', status: 'streaming' },
    id,
  );

  assert.equal(id2, id);
  assert.equal(fake.calls.list, listCallsBefore); // no re-list when existingId is passed
  assert.equal(fake.calls.update, 1);
  const row = fake.rows().find((r) => r.sessionId === 'session-2');
  assert.equal(row?.accumulatedText, 'First and second');
});

test('upsertActiveRun updates an existing row found by list when no id is passed', async () => {
  const firstId = await upsertActiveRun({
    sessionId: 'session-3',
    messageId: 'msg-3',
    accumulatedText: 'Hi',
    status: 'streaming',
  });

  // Simulate a second producer instance that lost its cached row id.
  const secondId = await upsertActiveRun({
    sessionId: 'session-3',
    messageId: 'msg-3',
    accumulatedText: 'Hi there',
    status: 'streaming',
  });

  assert.equal(secondId, firstId);
  const matching = fake.rows().filter((r) => r.sessionId === 'session-3');
  assert.equal(matching.length, 1); // one row per session, updated not duplicated
  assert.equal(matching[0]?.accumulatedText, 'Hi there');
});

test('clearActiveRun deletes the session row and fetchActiveRun returns null after', async () => {
  await upsertActiveRun({
    sessionId: 'session-4',
    messageId: 'msg-4',
    accumulatedText: 'Done soon',
    status: 'streaming',
  });
  assert.ok(await fetchActiveRun('session-4'));

  await clearActiveRun('session-4');

  assert.equal(await fetchActiveRun('session-4'), null);
});

test('upsertActiveRun swallows errors and returns null', async () => {
  const id = await upsertActiveRun(
    { sessionId: 'session-5', messageId: 'msg-5', accumulatedText: 'x', status: 'streaming' },
    'nonexistent-id',
  );
  assert.equal(id, null);
});
