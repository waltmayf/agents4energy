import { a } from '@aws-amplify/backend';

/**
 * Knowledge Graph storage model (issue #288, epic #294).
 *
 * A self-joining many-to-many `Node` ⇄ `Edge` graph — the same pattern proven by
 * `AgentSubAgent` in agentConfig.schema.ts. Amplify generates a DynamoDB table
 * for `Edge` with GSIs on both `fromId` and `toId` (via the `from`/`to`
 * belongsTo relations), giving us an adjacency list *with a reverse index* for
 * free: outgoing edges are queried by `fromId`, incoming edges by `toId`.
 *
 * This is the model-only slice — no traversal tool (#290), no ingestion (#292).
 * The bounded-depth frontier-expansion traversal tool reads this model over
 * AppSync; see docs/knowledge-graph.md (#293) for the traversal contract.
 */
export const knowledgeGraphSchema = a.schema({
  // An entity in the graph: a well, field, document, dataset, …
  Node: a.model({
    kind: a.string().required(), // "well" | "field" | "document" | "dataset" ...
    label: a.string(),
    props: a.json(),
    // Self-join relations — Amplify creates the reverse-index GSIs on Edge.
    outEdges: a.hasMany('Edge', 'fromId'),
    inEdges: a.hasMany('Edge', 'toId'),
  })
    // "list all nodes of kind X" — cheap and useful as a traversal seed.
    .secondaryIndexes((index) => [index('kind').queryField('listNodesByKind')])
    .authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),

  // A directed relationship between two nodes.
  Edge: a.model({
    fromId: a.id().required(),
    toId: a.id().required(),
    type: a.string().required(), // "belongs_to" | "mentions" | "derived_from" ...
    props: a.json(),
    from: a.belongsTo('Node', 'fromId'),
    to: a.belongsTo('Node', 'toId'),
  }).authorization((allow) => [
    allow.authenticated().to(['read', 'create', 'update', 'delete']),
    allow.owner(),
  ]),
});
