import { a } from '@aws-amplify/backend';
import { executeAthenaQuery, executeMapLayerQuery } from '../../functions/athena-query/resource';

/**
 * Athena Schema
 * Models and mutations for executing Athena queries
 */
export const athenaSchema = a.schema({
  
  // Athena Query Types
  AthenaQueryStatus: a.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]),

  AthenaQueryResult: a.customType({
    queryExecutionId: a.string().required(),
    status: a.ref("AthenaQueryStatus").required(),
    data: a.json(),
    columns: a.string().array(),
    error: a.string(),
    rowCount: a.integer(),
    nextToken: a.string(),
  }),

  // Result type for map layer query execution
  MapLayerQueryResult: a.customType({
    success: a.boolean().required(),
    geoJsonData: a.json(),
    error: a.string(),
    rowCount: a.integer(),
  }),

  // Mutation to execute Athena query
  executeAthenaQuery: a
    .mutation()
    .arguments({
      queryString: a.string(),
      database: a.string(),
      catalog: a.string(), // Add catalog for federated queries
      outputLocation: a.string(),
      queryExecutionId: a.string(),
      nextToken: a.string(),
    })
    .returns(a.ref("AthenaQueryResult"))
    .handler(a.handler.function(executeAthenaQuery))
    .authorization((allow) => [allow.authenticated()]),

  // Mutation to execute and validate a map layer query
  executeMapLayerQuery: a
    .mutation()
    .arguments({
      layerId: a.string(),
      queryString: a.string().required(),
      database: a.string().required(),
      geoJsonMapping: a.json().required(),
    })
    .returns(a.ref("MapLayerQueryResult"))
    .handler(a.handler.function(executeMapLayerQuery))
    .authorization((allow) => [allow.authenticated()]),

  // Subscription to receive query results
  onAthenaQueryResult: a
    .subscription()
    .for(a.ref("executeAthenaQuery"))
    .arguments({
      queryExecutionId: a.string().required()
    })
    .handler(a.handler.custom({ entry: "../subscriptions/athena-query.js" }))
    .authorization((allow) => [allow.authenticated()]),
});
