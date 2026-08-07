import { a } from '@aws-amplify/backend';

/**
 * Knowledge Graph Edge Schema
 * Represents a relationship between two nodes.
 */
export const edgeSchema = a.schema({
  Edge: a.model({
    edgeId: a.id().required(),
    fromNodeId: a.string().required(),
    toNodeId: a.string().required(),
    type: a.string().required(),
    // Edge-specific metadata
    properties: a.json(),
    createdAt: a.datetime(),
  })
    .secondaryIndexes((index) => [
      // Find edges outgoing from a node
      index('fromNodeId').queryField('listEdgesFromNode'),
      // Find edges incoming to a node
      index('toNodeId').queryField('listEdgesToNode'),
    ])
    .authorization((allow) => [allow.owner(), allow.authenticated(), allow.guest()]),
});
