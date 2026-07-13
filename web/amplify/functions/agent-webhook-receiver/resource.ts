import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookReceiver = defineFunction({
  name: 'agent-webhook-receiver',
  entry: './handler.ts',
  timeoutSeconds: 10,
  environment: {
    GITHUB_WEBHOOK_SECRET_ARN: process.env.GITHUB_WEBHOOK_SECRET_ARN ?? '',
    JIRA_WEBHOOK_SECRET_ARN: process.env.JIRA_WEBHOOK_SECRET_ARN ?? '',
    STATE_MACHINE_ARN: '',
  },
});
