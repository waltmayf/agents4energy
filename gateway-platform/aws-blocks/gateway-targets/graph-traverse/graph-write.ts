/**
 * Idempotent write helpers for the knowledge graph (issue #292).
 *
 * Storage-agnostic like graph-traverse-bfs.ts: callers inject a
 * `SignedGraphqlRequest` function that executes a GraphQL query/mutation
 * against AppSync (or a fake, for tests) so this module has no AWS SDK
 * dependency of its own.
 */

export type SignedGraphqlRequest = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Hard cap on a Node/Edge `props` blob so a single write can't grow the graph unboundedly. */
export const MAX_PROPS_BYTES = 8 * 1024;

export function clampProps(props: unknown): Record<string, unknown> | undefined {
  if (props === undefined || props === null) return undefined;
  const json = JSON.stringify(props);
  if (Buffer.byteLength(json, 'utf-8') <= MAX_PROPS_BYTES) return props as Record<string, unknown>;
  throw new Error(`props exceeds the ${MAX_PROPS_BYTES}-byte limit`);
}

/**
 * Deterministic natural key for a Node so the same real-world entity never
 * duplicates: a caller-supplied `naturalKey` prop wins, otherwise derive one
 * from `(kind, label)`.
 */
export function naturalKeyFor(kind: string, label: string | undefined, props: Record<string, unknown> | undefined): string {
  const explicit = props?.naturalKey;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return `${kind}:${label ?? ''}`;
}

interface RawNodeListItem {
  id: string;
  kind: string;
  label?: string | null;
  props?: unknown;
}

async function findNodeByNaturalKey(
  request: SignedGraphqlRequest,
  kind: string,
  naturalKey: string,
): Promise<RawNodeListItem | undefined> {
  let nextToken: string | undefined;
  do {
    const data = await request(
      `query ListNodesByKind($kind: String!, $nextToken: String) {
        listNodesByKind(kind: $kind, nextToken: $nextToken) {
          items { id kind label props }
          nextToken
        }
      }`,
      { kind, nextToken },
    );
    const conn = data.listNodesByKind as { items?: RawNodeListItem[]; nextToken?: string | null } | undefined;
    const match = (conn?.items ?? []).find(
      (n) => naturalKeyFor(n.kind, n.label ?? undefined, (n.props as Record<string, unknown>) ?? undefined) === naturalKey,
    );
    if (match) return match;
    nextToken = conn?.nextToken ?? undefined;
  } while (nextToken);
  return undefined;
}

export interface UpsertNodeInput {
  kind: string;
  label?: string;
  props?: unknown;
}

export interface UpsertResult {
  id: string;
  created: boolean;
}

/** Create-or-update a Node, idempotent on its natural key (see naturalKeyFor). */
export async function upsertNode(request: SignedGraphqlRequest, input: UpsertNodeInput): Promise<UpsertResult> {
  const { kind, label } = input;
  if (!kind) throw new Error('kind is required');

  const props = clampProps(input.props);
  const naturalKey = naturalKeyFor(kind, label, props);

  const existing = await findNodeByNaturalKey(request, kind, naturalKey);
  if (existing) {
    const data = await request(
      `mutation UpdateNode($input: UpdateNodeInput!) {
        updateNode(input: $input) { id }
      }`,
      { input: { id: existing.id, kind, label, props } },
    );
    const updated = data.updateNode as { id: string };
    return { id: updated.id, created: false };
  }

  const data = await request(
    `mutation CreateNode($input: CreateNodeInput!) {
      createNode(input: $input) { id }
    }`,
    { input: { kind, label, props } },
  );
  const created = data.createNode as { id: string };
  return { id: created.id, created: true };
}

interface RawEdgeListItem {
  id: string;
  fromId: string;
  toId: string;
  type: string;
}

async function findExistingEdge(
  request: SignedGraphqlRequest,
  fromId: string,
  toId: string,
  type: string,
): Promise<RawEdgeListItem | undefined> {
  let nextToken: string | undefined;
  do {
    const data = await request(
      `query GetNodeOutEdges($id: ID!, $nextToken: String) {
        getNode(id: $id) {
          outEdges(nextToken: $nextToken) {
            items { id fromId toId type }
            nextToken
          }
        }
      }`,
      { id: fromId, nextToken },
    );
    const node = data.getNode as { outEdges?: { items?: RawEdgeListItem[]; nextToken?: string | null } } | null;
    const conn = node?.outEdges;
    const match = (conn?.items ?? []).find((e) => e.toId === toId && e.type === type);
    if (match) return match;
    nextToken = conn?.nextToken ?? undefined;
  } while (nextToken);
  return undefined;
}

export interface UpsertEdgeInput {
  fromId: string;
  toId: string;
  type: string;
  props?: unknown;
}

/** Create an Edge, idempotent on (fromId, toId, type) — a no-op if it already exists. */
export async function upsertEdge(request: SignedGraphqlRequest, input: UpsertEdgeInput): Promise<UpsertResult> {
  const { fromId, toId, type } = input;
  if (!fromId) throw new Error('fromId is required');
  if (!toId) throw new Error('toId is required');
  if (!type) throw new Error('type is required');

  const props = clampProps(input.props);

  const existing = await findExistingEdge(request, fromId, toId, type);
  if (existing) return { id: existing.id, created: false };

  const data = await request(
    `mutation CreateEdge($input: CreateEdgeInput!) {
      createEdge(input: $input) { id }
    }`,
    { input: { fromId, toId, type, props } },
  );
  const created = data.createEdge as { id: string };
  return { id: created.id, created: true };
}
