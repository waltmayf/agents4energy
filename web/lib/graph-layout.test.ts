import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, type GraphNodeInput, type GraphEdgeInput } from './graph-layout.ts';

const node = (id: string, extra: Partial<GraphNodeInput> = {}): GraphNodeInput => ({
  id,
  kind: 'thing',
  label: id,
  ...extra,
});

const edge = (fromId: string, toId: string): GraphEdgeInput => ({
  id: `${fromId}->${toId}`,
  fromId,
  toId,
  type: 'rel',
});

test('empty input yields empty layout', () => {
  assert.deepEqual(layoutGraph([], []), []);
});

test('root sits at the origin on ring 0', () => {
  const out = layoutGraph([node('a'), node('b')], [edge('a', 'b')], { rootId: 'a' });
  const root = out.find((n) => n.id === 'a')!;
  assert.equal(root.ring, 0);
  assert.equal(root.x, 0);
  assert.equal(root.y, 0);
});

test('direct neighbours land on ring 1, two-hop on ring 2', () => {
  const out = layoutGraph(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c')],
    { rootId: 'a' },
  );
  assert.equal(out.find((n) => n.id === 'b')!.ring, 1);
  assert.equal(out.find((n) => n.id === 'c')!.ring, 2);
});

test('edge direction is ignored for ring placement (undirected shape)', () => {
  // b -> a, so a is the target; rooted at a, b is still one hop away.
  const out = layoutGraph([node('a'), node('b')], [edge('b', 'a')], { rootId: 'a' });
  assert.equal(out.find((n) => n.id === 'b')!.ring, 1);
});

test('disconnected nodes are marked as orphans (ring -1) and stay in the output', () => {
  const out = layoutGraph(
    [node('a'), node('b'), node('island')],
    [edge('a', 'b')],
    { rootId: 'a' },
  );
  assert.equal(out.length, 3);
  const island = out.find((n) => n.id === 'island')!;
  assert.equal(island.ring, -1);
  // Orphans still get a real position (not the origin).
  assert.notEqual(`${island.x},${island.y}`, '0,0');
});

test('falls back to the first node when rootId is missing or unknown', () => {
  const out = layoutGraph([node('a'), node('b')], [edge('a', 'b')], { rootId: 'nope' });
  assert.equal(out.find((n) => n.id === 'a')!.ring, 0);
});

test('ring radius scales with ringGap', () => {
  const out = layoutGraph([node('a'), node('b')], [edge('a', 'b')], { rootId: 'a', ringGap: 100 });
  const b = out.find((n) => n.id === 'b')!;
  // Single neighbour on ring 1 at radius 100, angle -PI/2 => straight up.
  assert.equal(Math.round(Math.hypot(b.x, b.y)), 100);
});

test('dangling edges referencing unknown nodes do not crash layout', () => {
  const out = layoutGraph([node('a'), node('b')], [edge('a', 'ghost'), edge('a', 'b')], { rootId: 'a' });
  assert.equal(out.length, 2);
  assert.equal(out.find((n) => n.id === 'b')!.ring, 1);
});

test('preserves node payload (s3Path passthrough)', () => {
  const out = layoutGraph([node('a', { s3Path: 'reports/q3.pdf', kind: 'document' })], []);
  assert.equal(out[0].s3Path, 'reports/q3.pdf');
  assert.equal(out[0].kind, 'document');
});
