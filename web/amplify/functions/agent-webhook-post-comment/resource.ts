import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookPostComment = defineFunction({
  name: 'agent-webhook-post-comment',
  entry: './handler.ts',
  timeoutSeconds: 30,
  environment: {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '',
    JIRA_BASE_URL: process.env.JIRA_BASE_URL ?? '',
    JIRA_API_TOKEN_SECRET_ARN: process.env.JIRA_API_TOKEN_SECRET_ARN ?? '',
    JIRA_API_EMAIL: process.env.JIRA_API_EMAIL ?? '',
    ACCOUNT_ID: '',
  },
});
