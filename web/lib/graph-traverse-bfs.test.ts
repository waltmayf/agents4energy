import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  traverse,
  MAX_DEPTH,
  type FetchEdges,
  type FetchNodes,
  type GraphEdge,
  type GraphNode,
} from './graph-traverse-bfs.ts';

// ── In-memory graph fixture + injectable fetchers ────────────────────────────
// A tiny adjacency list the fake fetchers read, so the BFS is exercised with no
// GraphQL/DynamoDB. Each fetch call is also recorded for cap/short-circuit
// assertions.

interface Graph {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

function makeFetchers(graph: Graph, calls?: { edges: string[] }) {
  const fetchEdges: FetchEdges = async (nodeId, direction, limit, edgeTypes) => {
    calls?.edges.push(`${nodeId}:${direction}`);
    let incident = graph.edges.filter((e) =>
      direction === 'out' ? e.fromId === nodeId : e.toId === nodeId,
    );
    if (edgeTypes?.length) incident = incident.filter((e) => edgeTypes.includes(e.type));
    // Simulate the +1 probe: keep limit, flag truncation when more exist.
    const truncated = incident.length > limit;
    return { edges: incident.slice(0, limit), truncated };
  };

  const fetchNodes: FetchNodes = async (ids) =>
    ids.map((id) => graph.nodes[id]).filter((n): n is GraphNode => Boolean(n));

  return { fetchEdges, fetchNodes };
}

function node(id: string, kind = 'well'): GraphNode {
  return { id, kind, label: id };
}
function edge(fromId: string, toId: string, type = 'rel'): GraphEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, type };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('depth=2 returns the 2-hop subgraph plus a non-empty frontier', async () => {
  // a -> b -> c -> d  (a chain); depth 2 from a reaches a,b,c and stops.
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b'), c: node('c'), d: node('d') },
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
  };
  const { fetchEdges, fetchNodes } = makeFetchers(graph);

  const res = await traverse({ rootId: 'a', depth: 2 }, fetchEdges, fetchNodes);

  const nodeIds = res.nodes.map((n) => n.id).sort();
  assert.deepEqual(nodeIds, ['a', 'b', 'c']);
  assert.deepEqual(res.edges.map((e) => e.id).sort(), ['a->b', 'b->c']);
  // The outer boundary at depth 2 is {c} — the re-root seed for a follow-up call.
  assert.deepEqual(res.frontier, ['c']);
  assert.equal(res.truncated, false);
  // d is one hop beyond the boundary and must not appear.
  assert.equal(res.nodes.find((n) => n.id === 'd'), undefined);
});

test('dense hub caps fan-out per level and flags truncated', async () => {
  // hub with 100 out-neighbours; perLevelLimit=10 keeps 10 and flags truncation.
  const nodes: Record<string, GraphNode> = { hub: node('hub') };
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 100; i++) {
    const id = `n${i}`;
    nodes[id] = node(id);
    edges.push(edge('hub', id));
  }
  const { fetchEdges, fetchNodes } = makeFetchers({ nodes, edges });

  const res = await traverse(
    { rootId: 'hub', depth: 3, perLevelLimit: 10 },
    fetchEdges,
    fetchNodes,
  );

  assert.equal(res.truncated, true);
  assert.equal(res.edges.length, 10); // capped, not an error
  assert.equal(res.nodes.length, 11); // hub + 10 kept neighbours
});

test('depth is clamped to MAX_DEPTH (no unbounded expansion)', async () => {
  // A long chain n0..n10; asking for depth 99 must stop at MAX_DEPTH hops.
  const nodes: Record<string, GraphNode> = {};
  const edges: GraphEdge[] = [];
  for (let i = 0; i <= 10; i++) nodes[`n${i}`] = node(`n${i}`);
  for (let i = 0; i < 10; i++) edges.push(edge(`n${i}`, `n${i + 1}`));
  const { fetchEdges, fetchNodes } = makeFetchers({ nodes, edges });

  const res = await traverse({ rootId: 'n0', depth: 99 }, fetchEdges, fetchNodes);

  // root + MAX_DEPTH hops worth of nodes.
  assert.equal(res.nodes.length, MAX_DEPTH + 1);
  assert.deepEqual(res.frontier, [`n${MAX_DEPTH}`]);
});

test('direction=in walks the reverse index', async () => {
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b'), c: node('c') },
    edges: [edge('a', 'c'), edge('b', 'c')],
  };
  const { fetchEdges, fetchNodes } = makeFetchers(graph);

  const res = await traverse({ rootId: 'c', depth: 1, direction: 'in' }, fetchEdges, fetchNodes);

  assert.deepEqual(res.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(res.edges.map((e) => e.id).sort(), ['a->c', 'b->c']);
});

test('direction=both probes out and in for every expanded node', async () => {
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b'), c: node('c') },
    edges: [edge('a', 'b'), edge('c', 'a')],
  };
  const calls = { edges: [] as string[] };
  const { fetchEdges, fetchNodes } = makeFetchers(graph, calls);

  const res = await traverse({ rootId: 'a', depth: 1, direction: 'both' }, fetchEdges, fetchNodes);

  assert.deepEqual(res.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  // root probed both directions.
  assert.ok(calls.edges.includes('a:out'));
  assert.ok(calls.edges.includes('a:in'));
});

test('edgeTypes filter is passed through and narrows results', async () => {
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b'), c: node('c') },
    edges: [edge('a', 'b', 'mentions'), edge('a', 'c', 'derived_from')],
  };
  const { fetchEdges, fetchNodes } = makeFetchers(graph);

  const res = await traverse(
    { rootId: 'a', depth: 1, edgeTypes: ['mentions'] },
    fetchEdges,
    fetchNodes,
  );

  assert.deepEqual(res.edges.map((e) => e.id), ['a->b']);
  assert.deepEqual(res.nodes.map((n) => n.id).sort(), ['a', 'b']);
});

test('cycles do not loop forever and dedupe nodes/edges', async () => {
  // a <-> b cycle; visiting must terminate and not double-count.
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b') },
    edges: [edge('a', 'b'), edge('b', 'a')],
  };
  const { fetchEdges, fetchNodes } = makeFetchers(graph);

  const res = await traverse({ rootId: 'a', depth: 5, direction: 'both' }, fetchEdges, fetchNodes);

  assert.deepEqual(res.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.deepEqual(res.edges.map((e) => e.id).sort(), ['a->b', 'b->a']);
});

test('depth=0 returns just the root, no edges, empty frontier', async () => {
  const graph: Graph = {
    nodes: { a: node('a'), b: node('b') },
    edges: [edge('a', 'b')],
  };
  const { fetchEdges, fetchNodes } = makeFetchers(graph);

  const res = await traverse({ rootId: 'a', depth: 0 }, fetchEdges, fetchNodes);

  assert.deepEqual(res.nodes.map((n) => n.id), ['a']);
  assert.deepEqual(res.edges, []);
  assert.deepEqual(res.frontier, []);
});

test('missing rootId throws', async () => {
  const { fetchEdges, fetchNodes } = makeFetchers({ nodes: {}, edges: [] });
  await assert.rejects(
    () => traverse({ rootId: '' }, fetchEdges, fetchNodes),
    /rootId is required/,
  );
});
