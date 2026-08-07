import { a } from '@aws-amplify/backend';

/**
 * Knowledge Graph Node Schema
 * Represents an entity in the knowledge graph.
 */
export const nodeSchema = a.schema({
  Node: a.model({
    // Unique identifier for the node
    nodeId: a.id().required(),
    // Type of entity, e.g., "Document", "Dataset", "Well", "Field"
    type: a.string().required(),
    // Arbitrary JSON payload with node metadata
    properties: a.json(),
    createdAt: a.datetime(),
  })
    .secondaryIndexes((index) => [
      // Query nodes by type
      index('type').queryField('listNodesByType'),
    ])
    .authorization((allow) => [allow.owner(), allow.authenticated(), allow.guest()]),
});
