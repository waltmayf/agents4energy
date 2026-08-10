import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestLineageSummary, parseLineageSummary } from './graph-ingest-lineage.ts';
import type { SignedGraphqlRequest } from './graph-write.ts';

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
}

function makeFakeApi() {
  const nodes = new Map<string, FakeNode>();
  const edges = new Map<string, FakeEdge>();
  let nextId = 1;

  const request: SignedGraphqlRequest = async (query, variables) => {
    if (query.includes('ListNodesByKind')) {
      const kind = variables.kind as string;
      return { listNodesByKind: { items: [...nodes.values()].filter((n) => n.kind === kind), nextToken: null } };
    }
    if (query.includes('GetNodeOutEdges')) {
      const id = variables.id as string;
      return { getNode: { outEdges: { items: [...edges.values()].filter((e) => e.fromId === id), nextToken: null } } };
    }
    if (query.includes('CreateNode')) {
      const input = variables.input as { kind: string; label?: string; props?: unknown };
      const id = `node-${nextId++}`;
      nodes.set(id, { id, ...input });
      return { createNode: { id } };
    }
    if (query.includes('UpdateNode')) {
      const input = variables.input as { id: string };
      nodes.set(input.id, { ...nodes.get(input.id)!, ...input });
      return { updateNode: { id: input.id } };
    }
    if (query.includes('CreateEdge')) {
      const input = variables.input as { fromId: string; toId: string; type: string };
      const id = `edge-${nextId++}`;
      edges.set(id, { id, ...input });
      return { createEdge: { id } };
    }
    throw new Error(`Unhandled query: ${query}`);
  };

  return { request, nodes, edges };
}

test('parseLineageSummary handles bare string entries', () => {
  const entries = parseLineageSummary(['wells/well-a.csv', 'wells/well-b.csv']);
  assert.equal(entries.length, 2);
});

test('parseLineageSummary de-dupes repeated entries', () => {
  const entries = parseLineageSummary(['a.csv', 'a.csv', { path: 'a.csv' }]);
  assert.equal(entries.length, 1);
});

test('parseLineageSummary ignores non-array / malformed input', () => {
  assert.deepEqual(parseLineageSummary(null), []);
  assert.deepEqual(parseLineageSummary(undefined), []);
  assert.deepEqual(parseLineageSummary('not-an-array'), []);
  assert.deepEqual(parseLineageSummary([42, {}, { kind: 'dataset' }]), []);
});

test('ingestLineageSummary creates a session node + one node/edge per dataset', async () => {
  const { request, nodes, edges } = makeFakeApi();
  const result = await ingestLineageSummary(request, 'session-1', ['wells/a.csv', 'wells/b.csv']);

  assert.equal(result.datasetNodeIds.length, 2);
  assert.equal(result.edgeIds.length, 2);
  assert.equal(nodes.size, 3); // 1 session + 2 dataset nodes
  assert.equal(edges.size, 2);
  for (const edge of edges.values()) {
    assert.equal(edge.type, 'accessed_in_session');
    assert.equal(edge.toId, result.sessionNodeId);
  }
});

test('ingestLineageSummary is idempotent — re-running produces no new nodes/edges', async () => {
  const { request, nodes, edges } = makeFakeApi();
  const first = await ingestLineageSummary(request, 'session-1', ['wells/a.csv', 'wells/b.csv']);
  const second = await ingestLineageSummary(request, 'session-1', ['wells/a.csv', 'wells/b.csv']);

  assert.deepEqual(second.datasetNodeIds.sort(), first.datasetNodeIds.sort());
  assert.deepEqual(second.edgeIds.sort(), first.edgeIds.sort());
  assert.equal(nodes.size, 3);
  assert.equal(edges.size, 2);
});

test('ingestLineageSummary handles an empty lineageSummary (session node only)', async () => {
  const { request, nodes, edges } = makeFakeApi();
  const result = await ingestLineageSummary(request, 'session-1', null);

  assert.equal(result.datasetNodeIds.length, 0);
  assert.equal(nodes.size, 1);
  assert.equal(edges.size, 0);
});

test('ingestLineageSummary respects an explicit kind on object entries', async () => {
  const { request, nodes } = makeFakeApi();
  await ingestLineageSummary(request, 'session-1', [{ path: 'reports/q3.pdf', kind: 'document' }]);

  const datasetNode = [...nodes.values()].find((n) => n.kind === 'document');
  assert.ok(datasetNode);
  assert.equal(datasetNode?.label, 'reports/q3.pdf');
});
