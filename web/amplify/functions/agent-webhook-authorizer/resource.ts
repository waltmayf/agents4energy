import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookAuthorizer = defineFunction({
  name: 'agent-webhook-authorizer',
  entry: './handler.ts',
  timeoutSeconds: 10,
});
