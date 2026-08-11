// Deterministic layout for the knowledge-graph explorer (issue #332).
//
// React Flow needs an (x, y) for every node but has no built-in layout engine.
// Rather than pull in dagre/elk, we place nodes on concentric rings by their
// BFS distance from a chosen root: the root sits at the centre, its direct
// neighbours on the first ring, and so on. Nodes unreachable from the root
// (disconnected components) are pushed to an outer "orphan" ring so they stay
// visible. Kept pure (no React, no DOM) so it's unit-testable.

export interface GraphNodeInput {
  id: string;
  kind: string;
  label?: string | null;
  /** `files/`-relative path when this node is linked to an S3 object. */
  s3Path?: string | null;
}

export interface GraphEdgeInput {
  id: string;
  fromId: string;
  toId: string;
  type: string;
}

export interface PositionedNode extends GraphNodeInput {
  x: number;
  y: number;
  /** Ring index from the root: 0 = root, -1 = disconnected/orphan. */
  ring: number;
}

export interface LayoutOptions {
  /** Node id to place at the centre. Defaults to the first node. */
  rootId?: string;
  /** Distance between concentric rings, in px. */
  ringGap?: number;
}

const DEFAULT_RING_GAP = 220;

/**
 * Build an undirected adjacency map from edges. Undirected because the explorer
 * lays out the *shape* of the graph — edge direction is rendered as an arrow,
 * not used to decide ring placement.
 */
function buildAdjacency(nodeIds: Set<string>, edges: GraphEdgeInput[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of edges) {
    // Skip edges that dangle off a node we weren't given.
    if (!adj.has(e.fromId) || !adj.has(e.toId)) continue;
    adj.get(e.fromId)!.add(e.toId);
    adj.get(e.toId)!.add(e.fromId);
  }
  return adj;
}

/** BFS ring (distance) for every node from the root; Infinity if unreachable. */
function bfsRings(rootId: string, adj: Map<string, Set<string>>): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(rootId, 0);
  let frontier = [rootId];
  let ring = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adj.get(id) ?? []) {
        if (!dist.has(neighbour)) {
          dist.set(neighbour, ring + 1);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
    ring += 1;
  }
  return dist;
}

/**
 * Position every node on a concentric-ring layout around `rootId`. Nodes are
 * grouped by ring; within a ring they're spread evenly around the circle. The
 * result is stable for a given (nodes, edges, root) — no randomness — so the
 * graph doesn't reshuffle on every render.
 */
export function layoutGraph(
  nodes: GraphNodeInput[],
  edges: GraphEdgeInput[],
  options: LayoutOptions = {},
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const ringGap = options.ringGap ?? DEFAULT_RING_GAP;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const rootId = options.rootId && nodeIds.has(options.rootId) ? options.rootId : nodes[0].id;

  const adj = buildAdjacency(nodeIds, edges);
  const dist = bfsRings(rootId, adj);

  // The highest finite ring — orphans are placed one ring beyond it.
  let maxRing = 0;
  for (const d of dist.values()) if (Number.isFinite(d) && d > maxRing) maxRing = d;
  const orphanRing = maxRing + 1;

  // Group node ids by the ring they'll render on.
  const byRing = new Map<number, string[]>();
  for (const node of nodes) {
    const d = dist.get(node.id);
    const renderRing = d === undefined || !Number.isFinite(d) ? orphanRing : d;
    if (!byRing.has(renderRing)) byRing.set(renderRing, []);
    byRing.get(renderRing)!.push(node.id);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const positioned: PositionedNode[] = [];

  for (const [renderRing, ids] of byRing) {
    const radius = renderRing * ringGap;
    const count = ids.length;
    ids.forEach((id, i) => {
      const node = byId.get(id)!;
      // Ring 0 (the root, count 1) sits dead centre; every other ring spreads
      // its members evenly around the circle. Offset by -PI/2 so the first node
      // starts at the top rather than the right.
      const angle = count === 0 ? 0 : (2 * Math.PI * i) / count - Math.PI / 2;
      const isOrphan = renderRing === orphanRing && (dist.get(id) === undefined || !Number.isFinite(dist.get(id)!));
      positioned.push({
        ...node,
        x: renderRing === 0 ? 0 : Math.round(radius * Math.cos(angle)),
        y: renderRing === 0 ? 0 : Math.round(radius * Math.sin(angle)),
        ring: isOrphan ? -1 : renderRing,
      });
    });
  }

  return positioned;
}
