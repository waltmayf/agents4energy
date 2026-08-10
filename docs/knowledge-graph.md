# Knowledge Graph

A generic entity graph — wells, fields, documents, datasets, chat sessions, and the relationships between them — stored in the same Amplify/AppSync/DynamoDB backend as the rest of the app, and exposed to agents as a bounded-depth traversal tool. Epic: #294. Shipped across #288 (data model), #290 (traversal), #291 (gateway target), #292 (write tools + ingestion).

---

## Data Model

Defined in [`web/amplify/data/schemas/knowledgeGraph.schema.ts`](../web/amplify/data/schemas/knowledgeGraph.schema.ts) as two Amplify `a.model()`s:

```typescript
Node: a.model({
  kind: a.string().required(),   // "well" | "field" | "document" | "dataset" | "session" ...
  label: a.string(),
  props: a.json(),
  outEdges: a.hasMany('Edge', 'fromId'),
  inEdges: a.hasMany('Edge', 'toId'),
})
  .secondaryIndexes((index) => [index('kind').queryField('listNodesByKind')])

Edge: a.model({
  fromId: a.id().required(),
  toId: a.id().required(),
  type: a.string().required(),   // "belongs_to" | "mentions" | "derived_from" | "accessed_in_session" ...
  props: a.json(),
  from: a.belongsTo('Node', 'fromId'),
  to: a.belongsTo('Node', 'toId'),
})
```

This is a **self-joining many-to-many** graph — a `Node` connects to any other `Node` through an `Edge` row, the same pattern `AgentSubAgent` uses in `agentConfig.schema.ts`. There's no fixed relationship taxonomy baked into the schema; `kind` and `type` are free-form strings interpreted by whoever writes and reads the graph.

Amplify maps each model to its own DynamoDB table. The two `belongsTo`/`hasMany` pairs (`from`/`outEdges` on `fromId`, `to`/`inEdges` on `toId`) make Amplify generate a GSI on `Edge.fromId` *and* a GSI on `Edge.toId` — so `Edge` is effectively an **adjacency list with both directions indexed for free**: a node's `outEdges` connection queries the `fromId` GSI, its `inEdges` connection queries the `toId` GSI. Both connections are real AppSync connections with `items`/`nextToken`, so paging a hub node's edges uses the standard cursor, not a client-side scan.

`Node.kind` also gets its own secondary index (`listNodesByKind`), used as a traversal seed — e.g. "list all `dataset` nodes" without needing a starting node id already in hand. `graph-write.ts` (below) also uses it to look up a node by natural key.

Authorization on both models: `allow.authenticated().to(['read','create','update','delete'])` plus `allow.owner()` — any signed-in principal (including a Lambda's IAM role, since AppSync IAM auth resolves through the same rule) can read and write.

---

## Write tools & ingestion

### `upsertNode` / `upsertEdge` — [`web/lib/graph-write.ts`](../web/lib/graph-write.ts)

Idempotent create-or-update helpers, storage-agnostic like the traversal core below: callers inject a `SignedGraphqlRequest` (`(query, variables) => Promise<data>`) so the module has no AWS SDK dependency of its own — real callers sign with SigV4, tests inject a fake.

- **`upsertNode(request, { kind, label?, props? })`** — idempotent on a **natural key**: `naturalKeyFor()` uses `props.naturalKey` if the caller supplied one, otherwise derives `` `${kind}:${label ?? ''}` ``. It pages through `listNodesByKind` looking for an existing node whose derived/explicit key matches, and updates it in place if found, otherwise creates a new `Node`. Returns `{ id, created }`.
- **`upsertEdge(request, { fromId, toId, type, props? })`** — idempotent on `(fromId, toId, type)`: pages the source node's `outEdges` looking for a match, no-ops (returns `{ id, created: false }`) if one exists, otherwise creates a new `Edge`.
- **`clampProps`** — both `props` blobs are capped at `MAX_PROPS_BYTES` (8 KiB of JSON) so a single write can't grow the graph unboundedly; an oversized `props` throws.

### `ingestLineageSummary` — [`web/lib/graph-ingest-lineage.ts`](../web/lib/graph-ingest-lineage.ts)

Turns `ChatSession.lineageSummary` (a free-form `a.json()` field on the `ChatSession` model — "consolidated list of datasets accessed during the session") into graph rows: one `session` node (natural key `session:<sessionId>`), one node per lineage entry (`kind` from the entry or defaulting to `dataset`), and an `accessed_in_session` edge from each entry node to the session node. Both the entry-parsing (`parseLineageSummary`) and the upserts are idempotent, so re-ingesting an unchanged `lineageSummary` produces no new rows. This module takes `upsertNode`/`upsertEdge` as injected `GraphWriteDeps` — a pluggable-ingestion-source pattern; a future ingestion source (e.g. listing S3 documents) would be a sibling module with the same shape, not a change to this one.

### Wiring — Lambdas + CDK constructs

| Piece | What it does |
|---|---|
| [`web/amplify/functions/graph-traverse/handler.ts`](../web/amplify/functions/graph-traverse/handler.ts) | Gateway-invoked Lambda backing three tools — `TraverseGraph`, `UpsertNode`, `UpsertEdge` — dispatched by `bedrockAgentCoreToolName` in the client context (same pattern as `s3-tools`). Signs its own AppSync requests with SigV4 via `fromNodeProviderChain()`; errors are returned as `{ error: message }` rather than thrown, so the agent sees a readable message instead of a 500. |
| [`web/amplify/functions/graph-ingest-lineage/handler.ts`](../web/amplify/functions/graph-ingest-lineage/handler.ts) | DynamoDB Stream handler on the `ChatSession` table (INSERT/MODIFY). Skips `MODIFY` events where `lineageSummary` itself didn't change, then calls `ingestLineageSummary`. Failures for one session are logged and skipped rather than failing the whole batch. |
| [`web/amplify/constructs/graphTraverseGatewayTarget/`](../web/amplify/constructs/graphTraverseGatewayTarget/) | CDK custom resource that calls `CreateGatewayTarget`/`UpdateGatewayTarget` to register the traversal Lambda on the AgentCore Gateway as a Lambda-backed MCP target, with the three tools' JSON-Schema `inputSchema`s inlined (`handler.ts`). |
| [`web/amplify/constructs/graphIngestLineage.ts`](../web/amplify/constructs/graphIngestLineage.ts) | CDK construct wrapping the ingestion Lambda + its `DynamoEventSource` on the `ChatSession` table. |
| `web/amplify/backend.ts` (search `KNOWLEDGE-GRAPH TRAVERSAL` / `GRAPH-INGEST-LINEAGE`) | Wires both Lambdas as raw `NodejsFunction`s in their own `backend.createStack(...)` sink stacks rather than shared `defineFunction`s — each needs the data stack's AppSync URL *and* (for traversal) the agent stack's gateway id/role, which would otherwise close a `data → function → data` CloudFormation cycle. Same pattern as `SyncCedarPolicies`/`S3ToolsGatewayTarget`. |

Both Lambdas' IAM roles are granted `appsync:GraphQL` on `Query/fields/*` **and** `Mutation/fields/*` on the API — a query-only grant would leave `UpsertNode`/`UpsertEdge`'s mutations silently rejected by AppSync's authorizer.

---

## Traversal Contract

Core logic — pure, storage-agnostic BFS — lives in [`web/lib/graph-traverse-bfs.ts`](../web/lib/graph-traverse-bfs.ts). It takes two injected functions, `fetchEdges` and `fetchNodes`, and issues no queries itself; [`graph-traverse/handler.ts`](../web/amplify/functions/graph-traverse/handler.ts) supplies the real AppSync-backed implementations (`fetchEdgesFromApi`/`fetchNodesFromApi`), and unit tests inject fakes.

The gateway exposes this as the `TraverseGraph` tool (alongside `UpsertNode`/`UpsertEdge`, all on the same Lambda-backed gateway target).

**Inputs** (`TraverseInput`):

| Field | Type | Default | Notes |
|---|---|---|---|
| `rootId` | `string` | — | required |
| `depth` | `number` | `3` | clamped to `[0, 5]` (`MAX_DEPTH = 5`) |
| `edgeTypes` | `string[]` | all types | allowlist pushed down into the AppSync connection's `filter` |
| `direction` | `'out' \| 'in' \| 'both'` | `'out'` | `'both'` probes both directions per node per hop |
| `perLevelLimit` | `number` | `50` | max edges expanded per node per direction per hop |

**Outputs** (`TraverseResult`):

| Field | Type | Meaning |
|---|---|---|
| `nodes` | `GraphNode[]` | every node visited within `depth` hops (root included) |
| `edges` | `GraphEdge[]` | every edge traversed to reach those nodes |
| `frontier` | `string[]` | node ids discovered at the outermost (last non-empty) BFS level — re-root a follow-up call here to expand further |
| `truncated` | `boolean` | `true` if any node's fan-out exceeded `perLevelLimit` in either direction at any hop, meaning the result is known-incomplete |

The BFS runs level by level: at each hop it fetches edges for every node in the current level (deduped against a `visited` set so cycles can't loop forever), keeps at most `perLevelLimit` per node per direction, and flags `truncated` whenever `fetchEdges` reports more edges existed than that. `fetchEdgesFromApi` implements the truncation check by requesting `limit + 1` items — a full page (or a returned `nextToken`) means more exist without needing a separate count query.

### The agent loop: query bounded → inspect → re-query from frontier

Because a single call is capped at `depth` hops and `perLevelLimit` edges per node, exploring a large or deep neighborhood is an explicit multi-call loop, not a single query:

1. Call `TraverseGraph` with a modest `depth` (the default, 3, is usually enough for one hop of context) from a known `rootId`.
2. Inspect the returned `nodes`/`edges`. If `truncated` is `true`, some node hit `perLevelLimit` — narrow with `edgeTypes` or accept the partial view.
3. To go deeper, call `TraverseGraph` again using one of the `frontier` ids as the new `rootId` — this is agent-controlled re-rooting, not a parameter that makes one query recurse further.
4. Repeat until the agent has gathered what it needs, or stop early once `nodes`/`edges` answer the question.

---

## Design Rationale

**Why Amplify/AppSync bounded-depth instead of Neptune or Iceberg.** A single GraphQL query against AppSync can't express a runtime-variable-depth traversal — resolvers are shaped by the schema, not by a request parameter that says "go N hops, N chosen at runtime." Rather than reach for a graph-native store (Neptune, with Gremlin/openCypher) to get that, the traversal tool moves the "how deep" decision to the *agent*: each call is a fixed, small, cheap bounded-depth BFS, and the agent decides whether to issue another call rooted at the `frontier`. This sidesteps the need for runtime-variable depth entirely — the agent's loop *is* the recursion, one bounded hop at a time.

**Why AppSync's `nextToken` pagination matters here.** Every `hasMany` connection (`outEdges`, `inEdges`, `listNodesByKind`) is a real AppSync connection with cursor-based `nextToken` pagination built in — `fetchEdgesFromApi`, `findNodeByNaturalKey`, and `findExistingEdge` all page through results this way. Neptune's traversal-result pagination is comparatively awkward (typically requires tracking Gremlin traversal state or re-issuing `range()` steps), which would complicate the same "walk a dense hub without loading it all at once" requirement this tool exists to satisfy.

**Why not Iceberg.** Iceberg is a batch/analytics table format — good for large-scale offline scans, not a fit for the interactive, single-entity-lookup, sub-second-latency access pattern an agent's tool call needs.

**The escape hatch.** `graph-traverse-bfs.ts`'s core takes `fetchEdges`/`fetchNodes` as injected functions and knows nothing about DynamoDB or AppSync; `graph-write.ts` takes an injected `SignedGraphqlRequest` and knows nothing about AppSync's transport either. The agent-facing tool contract (`TraverseGraph`/`UpsertNode`/`UpsertEdge`'s inputs and outputs) is decoupled from the storage layer by this injection. If a future scale or algorithm need justifies Neptune, only `fetchEdgesFromApi`/`fetchNodesFromApi`/`signedGraphqlRequest` (the AppSync-specific implementations in the Lambda handlers) would change — the tool names, input schema, and output shape the agent already knows how to call would not.

---

## Known Limits

- **No recursion / no runtime-variable depth in one GraphQL query.** `depth` is a parameter to the *tool*, resolved by the BFS loop inside the Lambda — not a single AppSync query that recurses. Deeper exploration requires additional tool calls re-rooted at `frontier`.
- **`depth` is capped at 5** (`MAX_DEPTH` in `graph-traverse-bfs.ts`) regardless of what the caller requests, to bound the worst-case fan-out of one call.
- **No path-finding or graph algorithms.** There's no shortest-path, centrality, or subgraph-matching support — the tool only does bounded BFS expansion. Anything more sophisticated has to be composed by the agent across multiple `TraverseGraph` calls.
- **Dense-hub fan-out is capped by `perLevelLimit`** (default 50 edges per node per direction per hop). A node with more edges than that returns a `truncated: true` result with only the first `perLevelLimit` edges in each direction; the agent must issue narrower follow-up calls (e.g. with an `edgeTypes` filter) to see the rest.
- **`props` is capped at 8 KiB of JSON** (`MAX_PROPS_BYTES` in `graph-write.ts`) per `Node`/`Edge` write — oversized metadata is rejected outright rather than truncated.
- **Ingestion currently has one source.** `graph-ingest-lineage` only materializes `ChatSession.lineageSummary`; there is no ingestion path yet for other domain data (e.g. energy/well datasets) beyond what an agent writes directly via `UpsertNode`/`UpsertEdge`.
