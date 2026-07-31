import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeActiveRunWithClient, type ActiveRunModelClient } from './logic.ts';

/**
 * In-memory fake of the ActiveRun model's Amplify Data client calls — same
 * shape as web/lib/active-run.test.ts's fake, just enough surface for
 * writeActiveRunWithClient's create/update/delete branching.
 */
function makeFakeClient(): ActiveRunModelClient & {
  calls: { create: number; update: number; delete: number; list: number };
  rows: () => Array<{ id: string; sessionId: string; messageId: string; accumulatedText: string; status: string; updatedAt: string }>;
} {
  let rows: Array<{ id: string; sessionId: string; messageId: string; accumulatedText: string; status: string; updatedAt: string }> = [];
  let nextId = 1;
  const calls = { create: 0, update: 0, delete: 0, list: 0 };

  return {
    calls,
    rows: () => rows,
    models: {
      ActiveRun: {
        list: async ({ filter }) => {
          calls.list++;
          const sessionId = filter.sessionId.eq;
          return { data: rows.filter((r) => r.sessionId === sessionId), errors: undefined };
        },
        create: async (input) => {
          calls.create++;
          const row = { id: `row-${nextId++}`, ...input };
          rows.push(row);
          return { data: row, errors: undefined };
        },
        update: async (input) => {
          calls.update++;
          const row = rows.find((r) => r.id === input.id);
          if (!row) return { data: undefined, errors: [{ message: 'not found' }] };
          Object.assign(row, input);
          return { data: row, errors: undefined };
        },
        delete: async ({ id }) => {
          calls.delete++;
          rows = rows.filter((r) => r.id !== id);
          return { data: { id }, errors: undefined };
        },
      },
    },
  };
}

test('streaming with no existing row creates a new one', async () => {
  const client = makeFakeClient();

  const result = await writeActiveRunWithClient(client, {
    sessionId: 'session-1',
    messageId: 'msg-1',
    accumulatedText: 'Hello',
    status: 'streaming',
  });

  assert.equal(result.ok, true);
  assert.ok(result.id);
  assert.equal(client.calls.create, 1);
  assert.equal(client.calls.update, 0);
  const row = client.rows().find((r) => r.sessionId === 'session-1');
  assert.equal(row?.accumulatedText, 'Hello');
  assert.equal(row?.status, 'streaming');
});

test('streaming with an existing row updates it instead of duplicating', async () => {
  const client = makeFakeClient();

  const first = await writeActiveRunWithClient(client, {
    sessionId: 'session-2',
    messageId: 'msg-2',
    accumulatedText: 'First',
    status: 'streaming',
  });

  const second = await writeActiveRunWithClient(client, {
    sessionId: 'session-2',
    messageId: 'msg-2',
    accumulatedText: 'First and second',
    status: 'streaming',
  });

  assert.equal(second.id, first.id);
  assert.equal(client.calls.create, 1);
  assert.equal(client.calls.update, 1);
  const matching = client.rows().filter((r) => r.sessionId === 'session-2');
  assert.equal(matching.length, 1);
  assert.equal(matching[0]?.accumulatedText, 'First and second');
});

test('status done deletes the session row(s) instead of writing', async () => {
  const client = makeFakeClient();

  await writeActiveRunWithClient(client, {
    sessionId: 'session-3',
    messageId: 'msg-3',
    accumulatedText: 'Almost done',
    status: 'streaming',
  });
  assert.equal(client.rows().filter((r) => r.sessionId === 'session-3').length, 1);

  const result = await writeActiveRunWithClient(client, {
    sessionId: 'session-3',
    messageId: 'msg-3',
    accumulatedText: 'Complete',
    status: 'done',
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, undefined);
  assert.equal(client.calls.delete, 1);
  assert.equal(client.rows().filter((r) => r.sessionId === 'session-3').length, 0);
});

test('explicit clear flag deletes the row even with status streaming', async () => {
  const client = makeFakeClient();

  await writeActiveRunWithClient(client, {
    sessionId: 'session-4',
    messageId: 'msg-4',
    accumulatedText: 'x',
    status: 'streaming',
  });

  const result = await writeActiveRunWithClient(client, {
    sessionId: 'session-4',
    messageId: 'msg-4',
    accumulatedText: 'x',
    status: 'streaming',
    clear: true,
  });

  assert.equal(result.ok, true);
  assert.equal(client.rows().filter((r) => r.sessionId === 'session-4').length, 0);
});

test('errors are swallowed and reported as ok: false, never thrown', async () => {
  const client = makeFakeClient();
  client.models.ActiveRun.create = async () => {
    throw new Error('write boom');
  };

  const result = await writeActiveRunWithClient(client, {
    sessionId: 'session-5',
    messageId: 'msg-5',
    accumulatedText: 'x',
    status: 'streaming',
  });

  assert.equal(result.ok, false);
});
