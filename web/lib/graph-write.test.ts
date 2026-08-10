import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertNode, upsertEdge, type SignedGraphqlRequest, MAX_PROPS_BYTES } from './graph-write.ts';

// ── Fake AppSync backed by an in-memory store ────────────────────────────────

interface FakeNode {
  id: string;
  kind: string;
  label?: string | null;
  props?: unknown;
}
interface FakeEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  props?: unknown;
}

function makeFakeApi() {
  const nodes = new Map<string, FakeNode>();
  const edges = new Map<string, FakeEdge>();
  let nextId = 1;

  const request: SignedGraphqlRequest = async (query, variables) => {
    if (query.includes('ListNodesByKind')) {
      const kind = variables.kind as string;
      const items = [...nodes.values()].filter((n) => n.kind === kind);
      return { listNodesByKind: { items, nextToken: null } };
    }
    if (query.includes('GetNodeOutEdges')) {
      const id = variables.id as string;
      const items = [...edges.values()].filter((e) => e.fromId === id);
      return { getNode: { outEdges: { items, nextToken: null } } };
    }
    if (query.includes('CreateNode')) {
      const input = variables.input as { kind: string; label?: string; props?: unknown };
      const id = `node-${nextId++}`;
      nodes.set(id, { id, ...input });
      return { createNode: { id } };
    }
    if (query.includes('UpdateNode')) {
      const input = variables.input as { id: string; kind: string; label?: string; props?: unknown };
      nodes.set(input.id, { ...nodes.get(input.id)!, ...input });
      return { updateNode: { id: input.id } };
    }
    if (query.includes('CreateEdge')) {
      const input = variables.input as { fromId: string; toId: string; type: string; props?: unknown };
      const id = `edge-${nextId++}`;
      edges.set(id, { id, ...input });
      return { createEdge: { id } };
    }
    throw new Error(`Unhandled query in fake API: ${query}`);
  };

  return { request, nodes, edges };
}

test('upsertNode creates a new node on first call', async () => {
  const { request, nodes } = makeFakeApi();
  const result = await upsertNode(request, { kind: 'well', label: 'Well A' });
  assert.equal(result.created, true);
  assert.equal(nodes.size, 1);
  assert.equal(nodes.get(result.id)?.label, 'Well A');
});

test('upsertNode is idempotent on (kind,label) natural key', async () => {
  const { request, nodes } = makeFakeApi();
  const first = await upsertNode(request, { kind: 'well', label: 'Well A', props: { depth: 100 } });
  const second = await upsertNode(request, { kind: 'well', label: 'Well A', props: { depth: 200 } });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(nodes.size, 1);
  assert.deepEqual(nodes.get(first.id)?.props, { depth: 200 });
});

test('upsertNode is idempotent on an explicit naturalKey prop', async () => {
  const { request, nodes } = makeFakeApi();
  const first = await upsertNode(request, { kind: 'dataset', label: 'A', props: { naturalKey: 'ds-1' } });
  const second = await upsertNode(request, { kind: 'dataset', label: 'different label', props: { naturalKey: 'ds-1' } });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(nodes.size, 1);
});

test('upsertNode requires kind', async () => {
  const { request } = makeFakeApi();
  await assert.rejects(() => upsertNode(request, { kind: '' }), /kind is required/);
});

test('upsertNode rejects oversized props', async () => {
  const { request } = makeFakeApi();
  const big = { blob: 'x'.repeat(MAX_PROPS_BYTES + 1) };
  await assert.rejects(() => upsertNode(request, { kind: 'well', props: big }), /exceeds/);
});

test('upsertEdge creates a new edge on first call', async () => {
  const { request, edges } = makeFakeApi();
  const result = await upsertEdge(request, { fromId: 'n1', toId: 'n2', type: 'belongs_to' });
  assert.equal(result.created, true);
  assert.equal(edges.size, 1);
});

test('upsertEdge is idempotent on (fromId,toId,type)', async () => {
  const { request, edges } = makeFakeApi();
  const first = await upsertEdge(request, { fromId: 'n1', toId: 'n2', type: 'belongs_to' });
  const second = await upsertEdge(request, { fromId: 'n1', toId: 'n2', type: 'belongs_to' });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(edges.size, 1);
});

test('upsertEdge allows a different type between the same two nodes', async () => {
  const { request, edges } = makeFakeApi();
  await upsertEdge(request, { fromId: 'n1', toId: 'n2', type: 'belongs_to' });
  await upsertEdge(request, { fromId: 'n1', toId: 'n2', type: 'mentions' });
  assert.equal(edges.size, 2);
});

test('upsertEdge requires fromId/toId/type', async () => {
  const { request } = makeFakeApi();
  await assert.rejects(() => upsertEdge(request, { fromId: '', toId: 'n2', type: 't' }), /fromId is required/);
  await assert.rejects(() => upsertEdge(request, { fromId: 'n1', toId: '', type: 't' }), /toId is required/);
  await assert.rejects(() => upsertEdge(request, { fromId: 'n1', toId: 'n2', type: '' }), /type is required/);
});
