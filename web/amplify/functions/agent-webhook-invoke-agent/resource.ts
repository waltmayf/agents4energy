import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookInvokeAgent = defineFunction({
  name: 'agent-webhook-invoke-agent',
  entry: './handler.ts',
  timeoutSeconds: 840,
  environment: {
    AGUI_RUNTIME_ARN: '',
  },
});
