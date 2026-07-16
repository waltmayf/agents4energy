import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookVerify = defineFunction({
  name: 'agent-webhook-verify',
  entry: './handler.ts',
  timeoutSeconds: 60,
  environment: {},
});
