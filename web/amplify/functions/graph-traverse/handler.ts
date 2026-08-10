import type { Context } from 'aws-lambda';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import {
  traverse,
  type Direction,
  type EdgePage,
  type GraphEdge,
  type GraphNode,
  type TraverseInput,
} from '../../../lib/graph-traverse-bfs';

// The AppSync GraphQL endpoint + region are injected in backend.ts once the
// data stack exists (see the GRAPHQL_URL/GRAPHQL_REGION wiring). The traversal
// reads the Node/Edge models over AppSync with SigV4 (IAM auth), the same
// pattern as s3ToolsMcpServerSeed — no DynamoDB coupling, so the storage layer
// can later swap to Neptune without touching the agent-facing tool contract.
const GRAPHQL_URL = process.env.GRAPHQL_URL!;
const GRAPHQL_REGION = process.env.GRAPHQL_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const credentialProvider = fromNodeProviderChain();

async function signedGraphqlRequest(
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(GRAPHQL_URL);
  const body = JSON.stringify({ query, variables });

  const request = new HttpRequest({
    method: 'POST',
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: endpoint.pathname,
    headers: { 'Content-Type': 'application/json', host: endpoint.hostname },
    body,
  });

  const signer = new SignatureV4({
    credentials: credentialProvider,
    region: GRAPHQL_REGION,
    service: 'appsync',
    sha256: Sha256,
  });
  const signed = await signer.sign(request);

  const res = await fetch(GRAPHQL_URL, { method: signed.method, headers: signed.headers, body: signed.body });
  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data ?? {};
}

interface RawEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  props?: unknown;
}
interface EdgeConnection {
  items?: RawEdge[];
  nextToken?: string | null;
}
interface RawNode {
  id: string;
  kind: string;
  label?: string | null;
  props?: unknown;
  outEdges?: EdgeConnection;
  inEdges?: EdgeConnection;
}

/**
 * Fetch one node's edges in a single direction via its reverse-index
 * connection field. We request `limit + 1` items so a full page signals more
 * edges exist (the BFS keeps only `limit` and flags `truncated`) without a
 * second count query. `edgeTypes` is pushed down to the connection `filter` so
 * the GSI does the type filtering rather than shipping every edge back.
 */
async function fetchEdgesFromApi(
  nodeId: string,
  direction: 'out' | 'in',
  limit: number,
  edgeTypes: string[] | undefined,
): Promise<EdgePage> {
  const field = direction === 'out' ? 'outEdges' : 'inEdges';
  const filter = edgeTypes?.length ? { type: { in: edgeTypes } } : undefined;

  const data = await signedGraphqlRequest(
    `query GetNodeEdges($id: ID!, $limit: Int!, $filter: ModelEdgeFilterInput) {
      getNode(id: $id) {
        ${field}(limit: $limit, filter: $filter) {
          items { id fromId toId type props }
          nextToken
        }
      }
    }`,
    { id: nodeId, limit: limit + 1, filter },
  );

  const node = data.getNode as RawNode | null;
  const conn = node?.[field] as EdgeConnection | undefined;
  const items = conn?.items ?? [];
  const edges: GraphEdge[] = items.map((e) => ({
    id: e.id,
    fromId: e.fromId,
    toId: e.toId,
    type: e.type,
    props: e.props,
  }));

  // More than `limit` edges available → the fan-out is capped for this node.
  const truncated = edges.length > limit || Boolean(conn?.nextToken);
  return { edges, truncated };
}

/** Load node records by id in parallel (deduped upstream). */
async function fetchNodesFromApi(ids: string[]): Promise<GraphNode[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      const data = await signedGraphqlRequest(
        `query GetNode($id: ID!) {
          getNode(id: $id) { id kind label props }
        }`,
        { id },
      );
      const node = data.getNode as RawNode | null;
      if (!node) return undefined;
      return { id: node.id, kind: node.kind, label: node.label, props: node.props } as GraphNode;
    }),
  );
  return results.filter((n): n is GraphNode => n !== undefined);
}

// Guard against unbounded growth in a single Node/Edge `props` blob (issue
// #292) — callers (agent tool calls or ingestion) shouldn't be able to stuff
// arbitrarily large payloads into the graph.
const MAX_PROPS_BYTES = 8 * 1024;

function clampProps(props: unknown): unknown {
  if (props === undefined || props === null) return undefined;
  const json = JSON.stringify(props);
  if (Buffer.byteLength(json, 'utf-8') <= MAX_PROPS_BYTES) return props;
  throw new Error(`props exceeds the ${MAX_PROPS_BYTES}-byte limit`);
}

/**
 * Deterministic natural key for a Node so the same real-world entity never
 * duplicates: a caller-supplied `naturalKey` prop wins, otherwise derive one
 * from `(kind, label)`.
 */
function naturalKeyFor(kind: string, label: string | undefined, props: Record<string, unknown> | undefined): string {
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

async function findNodeByNaturalKey(kind: string, naturalKey: string): Promise<RawNodeListItem | undefined> {
  let nextToken: string | undefined;
  do {
    const data = await signedGraphqlRequest(
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

interface UpsertNodeEvent {
  kind?: string;
  label?: string;
  props?: Record<string, unknown>;
}

async function handleUpsertNode(event: UpsertNodeEvent): Promise<unknown> {
  const { kind, label } = event;
  if (!kind) throw new Error('kind is required');

  const props = clampProps(event.props) as Record<string, unknown> | undefined;
  const naturalKey = naturalKeyFor(kind, label, props);

  const existing = await findNodeByNaturalKey(kind, naturalKey);
  if (existing) {
    const data = await signedGraphqlRequest(
      `mutation UpdateNode($input: UpdateNodeInput!) {
        updateNode(input: $input) { id }
      }`,
      { input: { id: existing.id, kind, label, props } },
    );
    const updated = data.updateNode as { id: string };
    return { id: updated.id, created: false };
  }

  const data = await signedGraphqlRequest(
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

async function findExistingEdge(fromId: string, toId: string, type: string): Promise<RawEdgeListItem | undefined> {
  let nextToken: string | undefined;
  do {
    const data = await signedGraphqlRequest(
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

interface UpsertEdgeEvent {
  fromId?: string;
  toId?: string;
  type?: string;
  props?: Record<string, unknown>;
}

async function handleUpsertEdge(event: UpsertEdgeEvent): Promise<unknown> {
  const { fromId, toId, type } = event;
  if (!fromId) throw new Error('fromId is required');
  if (!toId) throw new Error('toId is required');
  if (!type) throw new Error('type is required');

  const props = clampProps(event.props) as Record<string, unknown> | undefined;

  const existing = await findExistingEdge(fromId, toId, type);
  if (existing) return { id: existing.id, created: false };

  const data = await signedGraphqlRequest(
    `mutation CreateEdge($input: CreateEdgeInput!) {
      createEdge(input: $input) { id }
    }`,
    { input: { fromId, toId, type, props } },
  );
  const created = data.createEdge as { id: string };
  return { id: created.id, created: true };
}

// The gateway invokes this Lambda directly — the event IS the tool's input
// arguments (see s3-tools/handler.ts). Three tools (`TraverseGraph`,
// `UpsertNode`, `UpsertEdge`) back this target, so dispatch on
// bedrockAgentCoreToolName the same way s3-tools does.
interface GatewayClientContext {
  custom?: {
    bedrockAgentCoreToolName?: string;
  };
}

function extractToolName(context: Context): string {
  const raw = (context.clientContext as GatewayClientContext | undefined)?.custom?.bedrockAgentCoreToolName;
  if (!raw) return 'TraverseGraph'; // Backward-compatible default when invoked outside the gateway (e.g. direct test).
  const idx = raw.lastIndexOf('___');
  return idx === -1 ? raw : raw.slice(idx + 3);
}

interface TraverseEvent {
  rootId?: string;
  depth?: number;
  edgeTypes?: string[];
  direction?: string;
  perLevelLimit?: number;
}

function normalizeDirection(direction: string | undefined): Direction {
  return direction === 'in' || direction === 'both' ? direction : 'out';
}

async function handleTraverse(event: TraverseEvent): Promise<unknown> {
  if (!event.rootId) throw new Error('rootId is required');

  const input: TraverseInput = {
    rootId: event.rootId,
    depth: event.depth,
    edgeTypes: event.edgeTypes,
    direction: normalizeDirection(event.direction),
    perLevelLimit: event.perLevelLimit,
  };

  return await traverse(input, fetchEdgesFromApi, fetchNodesFromApi);
}

type ToolEvent = TraverseEvent & UpsertNodeEvent & UpsertEdgeEvent;

export const handler = async (event: ToolEvent, context: Context): Promise<unknown> => {
  const toolName = extractToolName(context);

  try {
    switch (toolName) {
      case 'UpsertNode':
        return await handleUpsertNode(event);
      case 'UpsertEdge':
        return await handleUpsertEdge(event);
      case 'TraverseGraph':
      default:
        return await handleTraverse(event);
    }
  } catch (err) {
    // Gateway-target tools return errors as a value, not by throwing (matches
    // s3-tools) so the agent sees a readable message instead of a 500.
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
};
