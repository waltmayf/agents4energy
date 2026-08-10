/**
 * Bounded-depth frontier-expansion BFS over the knowledge graph (issue #290).
 *
 * Storage-agnostic core: the traversal issues no queries itself, it drives an
 * injected `fetchEdges` function that returns the edges incident to a single
 * node in one direction. That keeps the agent-facing contract free of any
 * DynamoDB/AppSync assumption (the backend can later swap to Neptune) and makes
 * the BFS unit-testable without a live GraphQL API.
 *
 * The tool returns everything within `depth` hops of `rootId`, plus the
 * `frontier` node IDs at the outer boundary so the agent can re-root a follow-up
 * call to explore further — bounded queries, agent decides whether to expand.
 */

/** Hard server-side cap on depth — protects against dense-hub blowup. */
export const MAX_DEPTH = 5;
/** Default hop count when the caller omits `depth`. */
export const DEFAULT_DEPTH = 3;
/** Default per-level fan-out width cap. */
export const DEFAULT_PER_LEVEL_LIMIT = 50;

export type Direction = 'out' | 'in' | 'both';

export interface TraverseInput {
  rootId: string;
  depth?: number;
  edgeTypes?: string[];
  direction?: Direction;
  perLevelLimit?: number;
}

export interface GraphNode {
  id: string;
  kind: string;
  label?: string | null;
  props?: unknown;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  props?: unknown;
}

export interface TraverseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node IDs at the outer boundary — roots for the next expansion call. */
  frontier: string[];
  /** True when a per-level limit capped the fan-out (results are incomplete). */
  truncated: boolean;
}

/**
 * Fetches up to `limit + 1` edges incident to `nodeId` in `direction`,
 * optionally filtered to `edgeTypes`. Returns `{ edges, truncated }` where
 * `truncated` is true if more than `limit` edges exist (the caller keeps only
 * `limit`). The `+1` probe lets the BFS report truncation without an unbounded
 * scan. `direction` here is always 'out' or 'in' (never 'both' — the BFS splits
 * 'both' into two calls).
 */
export interface EdgePage {
  edges: GraphEdge[];
  truncated: boolean;
}
export type FetchEdges = (
  nodeId: string,
  direction: 'out' | 'in',
  limit: number,
  edgeTypes: string[] | undefined,
) => Promise<EdgePage>;

/** Loads node records by id (deduped, single batch). */
export type FetchNodes = (ids: string[]) => Promise<GraphNode[]>;

function clampDepth(depth: number | undefined): number {
  const d = depth ?? DEFAULT_DEPTH;
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.min(Math.floor(d), MAX_DEPTH);
}

function clampPerLevel(limit: number | undefined): number {
  const l = limit ?? DEFAULT_PER_LEVEL_LIMIT;
  if (!Number.isFinite(l) || l < 1) return DEFAULT_PER_LEVEL_LIMIT;
  return Math.floor(l);
}

/** The concrete per-node directions to probe for a given traversal direction. */
function directionsFor(direction: Direction): Array<'out' | 'in'> {
  if (direction === 'both') return ['out', 'in'];
  return [direction];
}

/**
 * Run the bounded BFS. Visits level by level up to the clamped depth, capping
 * each node's fan-out at `perLevelLimit` per direction and flagging `truncated`
 * whenever that cap hides edges — never silently dropping without the flag.
 */
export async function traverse(
  input: TraverseInput,
  fetchEdges: FetchEdges,
  fetchNodes: FetchNodes,
): Promise<TraverseResult> {
  if (!input.rootId) throw new Error('rootId is required');

  const depth = clampDepth(input.depth);
  const perLevelLimit = clampPerLevel(input.perLevelLimit);
  const direction = input.direction ?? 'out';
  const dirs = directionsFor(direction);

  const visited = new Set<string>([input.rootId]);
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncated = false;

  // Nodes discovered at the current BFS level whose edges we expand next.
  let currentLevel: string[] = [input.rootId];
  // The last non-empty boundary — reported as `frontier` for re-rooting.
  let frontier: string[] = [];

  for (let hop = 0; hop < depth; hop++) {
    const nextLevel: string[] = [];

    for (const nodeId of currentLevel) {
      for (const dir of dirs) {
        const page = await fetchEdges(nodeId, dir, perLevelLimit, input.edgeTypes);
        if (page.truncated) truncated = true;

        for (const edge of page.edges.slice(0, perLevelLimit)) {
          if (!edgeIds.has(edge.id)) {
            edgeIds.add(edge.id);
            edges.push(edge);
          }
          // The neighbour is the other end of the edge relative to `dir`.
          const neighbour = dir === 'out' ? edge.toId : edge.fromId;
          if (!visited.has(neighbour)) {
            visited.add(neighbour);
            nextLevel.push(neighbour);
          }
        }
      }
    }

    if (nextLevel.length === 0) break;
    frontier = nextLevel;
    currentLevel = nextLevel;
  }

  const nodes = await fetchNodes([...visited]);
  return { nodes, edges, frontier, truncated };
}
