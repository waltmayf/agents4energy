# Knowledge Graph

This document describes the **knowledge‑graph** feature, its data model, the traversal tool contract, design rationale, and known limits.

---

## Data Model

The graph is stored in DynamoDB using a **self‑joining M:N** design:

- **Node** – represents an entity in the graph. Stored as a DynamoDB item with a primary key `PK = NODE#<nodeId>` and sort key `SK = META`.
- **Edge** – represents a directed relationship between two nodes. Stored as an item with `PK = NODE#<sourceNodeId>` and `SK = EDGE#<edgeId>#<targetNodeId>`. The edge also contains an `edgeType` attribute.

To enable efficient reverse look‑ups, a **Global Secondary Index (GSI)** is defined:

- `GSI1PK = EDGE#<targetNodeId>`
- `GSI1SK = EDGE#<sourceNodeId>#<edgeId>`

This adjacency‑list pattern allows querying a node's outgoing edges (primary key) and incoming edges (GSI) with pagination via the standard AppSync `nextToken` cursor.

---

## Traversal Contract (Frontier‑Expansion Tool)

The backend exposes a **tool** named `knowledge_graph_traverse` (or similar) that agents can invoke. The contract is:

**Inputs**
- `rootId: string` – starting node identifier.
- `depth: number` – maximum number of hops from the root (bounded depth).
- `edgeTypes?: string[]` – optional filter restricting which edge types are followed.
- `direction?: "out" | "in" | "both"` – which direction to traverse.
- `perLevelLimit?: number` – maximum edges returned per node per level (prevents hub explosion).

**Outputs**
- `nodes: Node[]` – the collection of nodes discovered (including the root).
- `edges: Edge[]` – the edges that connect the returned nodes.
- `frontier: string[]` – the set of node IDs at the deepest returned level that can be used for a subsequent call (enables iterative expansion).
- `truncated: boolean` – true if the request hit a `perLevelLimit` or the global `maxResults` limit, indicating the agent may need to continue from the frontier.

**Usage pattern**
1. Call the tool with a modest `depth` (e.g., 2) to get a bounded sub‑graph.
2. Inspect the returned nodes/edges in the agent’s reasoning.
3. If `truncated` is true or further detail is needed, invoke the tool again using one of the IDs from `frontier` as the new `rootId`.
4. Repeat until the desired portion of the graph is gathered.

This design avoids the need for a single GraphQL query with a variable depth, which Amplify/AppSync does not support.

---

## Design Rationale

- **Amplify + AppSync bounded depth** – GraphQL queries in Amplify cannot express a runtime‑variable traversal depth; they must have a static depth defined in the schema. By exposing a tool that performs a bounded traversal on the backend, the agent can control expansion iteratively without hitting this limitation.
- **Cursor pagination** – DynamoDB adjacency lists expose `nextToken` via AppSync, giving reliable paging for large neighborhoods. Neptune traversal pagination is more cumbersome and often requires client‑side state.
- **Avoiding Neptune/Iceberg** – While graph‑native stores provide richer algorithms, they add operational complexity and lock‑in. The current tool contract is **storage‑agnostic**; swapping the implementation to Neptune later would not change the agent‑facing API, preserving backwards compatibility.
- **Frontier‑expansion** – By returning a `frontier` list, the agent can decide which region to explore next, keeping calls small and avoiding fan‑out explosions from high‑degree hub nodes.

---

## Known Limits

- **No recursive single‑query traversal** – A single GraphQL request cannot recurse beyond the static depth defined in the schema.
- **No built‑in graph algorithms** – Path‑finding, shortest‑path, or centrality calculations are not provided; the agent must implement such logic in its prompt or via multiple tool calls.
- **Hub fan‑out capped** – `perLevelLimit` prevents a node with many outgoing edges from returning the entire set in one call; the agent must paginate through the hub using subsequent calls.
- **Consistency** – The graph is eventually consistent across DynamoDB tables; very rapid updates may not be visible immediately to a traversal.

---

For a deeper dive, see the related backend code in `web/amplify/functions/` and the GraphQL schema definitions under `web/amplify/data/schemas/`.
