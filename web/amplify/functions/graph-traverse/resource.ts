import { defineFunction } from '@aws-amplify/backend';

export const graphTraverse = defineFunction({
  name: 'graph-traverse',
  entry: './handler.ts',
  timeoutSeconds: 300,
  // No env vars needed for stub.
});
