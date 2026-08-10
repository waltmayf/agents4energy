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
import { upsertNode, upsertEdge, type UpsertNodeInput, type UpsertEdgeInput } from '../../../lib/graph-write';

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
  // Amplify's ModelStringInput has no `in` operator — express "type ∈ edgeTypes"
  // as an OR of `eq` clauses (a single-element list still works as `or: [{...}]`).
  const filter = edgeTypes?.length ? { or: edgeTypes.map((t) => ({ type: { eq: t } })) } : undefined;

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

type ToolEvent = TraverseEvent & UpsertNodeInput & UpsertEdgeInput;

export const handler = async (event: ToolEvent, context: Context): Promise<unknown> => {
  const toolName = extractToolName(context);

  try {
    switch (toolName) {
      case 'UpsertNode':
        return await upsertNode(signedGraphqlRequest, event);
      case 'UpsertEdge':
        return await upsertEdge(signedGraphqlRequest, event);
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
