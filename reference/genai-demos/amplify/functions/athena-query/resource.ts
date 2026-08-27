import { defineFunction } from '@aws-amplify/backend';

export const executeAthenaQuery = defineFunction({
  name: 'execute-athena-query',
  entry: './executeAthenaQuery.ts',
  timeoutSeconds: 900, // 15 minutes - enough for long-running Athena queries
  memoryMB: 1024,
  resourceGroupName: 'data', // Assign to data stack (uses GraphQL API)
});

export const executeMapLayerQuery = defineFunction({
  name: 'execute-map-layer-query',
  entry: './executeMapLayerQuery.ts',
  timeoutSeconds: 900, // 15 minutes - enough for long-running Athena queries
  memoryMB: 1024,
  resourceGroupName: 'data', // Assign to data stack (uses GraphQL API)
});