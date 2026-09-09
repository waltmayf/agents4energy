import { SchemaType, type ToolDefinition } from '@aws-sdk/client-bedrock-agentcore-control';

// MCP tool schema for the graph-traverse gateway target (issue #291) — moved
// verbatim from web/amplify/constructs/graphTraverseGatewayTarget/handler.ts
// as part of #536. The Lambda implementing these tools is a local copy at
// ./graph-traverse/handler.ts (see its header comment for why).
//
// Shared by UpsertNode/UpsertEdge below — free-form metadata on a Node/Edge,
// capped at MAX_PROPS_BYTES in the handler (issue #292).
const PROPS_PROPERTY = {
  type: SchemaType.OBJECT,
  description:
    'Optional free-form metadata as a JSON object (e.g. {"units":"bbl"}). Capped at 8KB; oversized props are rejected. '
    + 'Include a "naturalKey" string field to control de-duplication explicitly instead of the default (kind,label) key.',
};

// Keep in sync with the graph-traverse handler's TraverseEvent + the
// MAX_DEPTH/DEFAULT_* clamps in ./graph-traverse/graph-traverse-bfs.ts.
export const graphTraverseToolDefinitions: ToolDefinition[] = [
  {
    name: 'TraverseGraph',
    description:
      'Traverse the knowledge graph outward from a root node, returning every node and edge within '
      + 'a bounded number of hops plus the frontier boundary node ids (for re-rooting a deeper query). '
      + 'Use it to explore how an entity (well, field, document, dataset, …) connects to its neighbours. '
      + 'The result is { nodes, edges, frontier, truncated }; `truncated` is true when a node\'s fan-out '
      + 'exceeded perLevelLimit and edges were dropped.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        rootId: {
          type: SchemaType.STRING,
          description: 'Id of the node to start traversing from (required).',
        },
        depth: {
          type: SchemaType.INTEGER,
          description: 'How many hops to expand. Defaults to 3, clamped to a maximum of 5.',
        },
        direction: {
          type: SchemaType.STRING,
          description:
            'Which edges to follow: "out" (fromId → toId, default), "in" (reverse), or "both". '
            + 'One of "out" | "in" | "both".',
        },
        edgeTypes: {
          type: SchemaType.ARRAY,
          description:
            'Optional edge-type allowlist (e.g. ["belongs_to","derived_from"]). Omit to follow all edge types.',
          items: { type: SchemaType.STRING },
        },
        perLevelLimit: {
          type: SchemaType.INTEGER,
          description:
            'Max edges to expand per node per direction (default 50). Caps fan-out at dense hub nodes; '
            + 'when exceeded the result\'s `truncated` flag is set.',
        },
      },
      required: ['rootId'],
    },
  },
  {
    name: 'UpsertNode',
    description:
      'Create or update an entity node in the knowledge graph (a well, field, document, dataset, …). Idempotent: '
      + 'looks up an existing node by natural key (props.naturalKey, or "kind:label" if omitted) and updates it '
      + 'instead of creating a duplicate. To link a node to a file in the agent workspace, set '
      + 'props.s3Path to the "files/"-relative path (e.g. "reports/q3.pdf") — the graph explorer UI turns that '
      + 'into an "Open file" button that presigns and opens the S3 object. Returns { id, created }.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        kind: {
          type: SchemaType.STRING,
          description: 'Entity kind, e.g. "well" | "field" | "document" | "dataset" | "session" (required).',
        },
        label: {
          type: SchemaType.STRING,
          description: 'Human-readable name for the node.',
        },
        props: PROPS_PROPERTY,
      },
      required: ['kind'],
    },
  },
  {
    name: 'UpsertEdge',
    description:
      'Create a directed relationship between two nodes (e.g. "belongs_to", "mentions", "derived_from", '
      + '"accessed_in_session"). Idempotent: a no-op if an edge with the same (fromId,toId,type) already exists. '
      + 'Returns { id, created }.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        fromId: {
          type: SchemaType.STRING,
          description: 'Id of the source node (required).',
        },
        toId: {
          type: SchemaType.STRING,
          description: 'Id of the target node (required).',
        },
        type: {
          type: SchemaType.STRING,
          description: 'Edge type, e.g. "belongs_to" | "mentions" | "derived_from" | "accessed_in_session" (required).',
        },
        props: PROPS_PROPERTY,
      },
      required: ['fromId', 'toId', 'type'],
    },
  },
];
