import { defineFunction } from '@aws-amplify/backend';

export const completeResourceTokenAuth = defineFunction({
  name: 'complete-resource-token-auth',
  entry: './handler.ts',
});
