import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookInvokeAgent = defineFunction({
  name: 'agent-webhook-invoke-agent',
  entry: './handler.ts',
  timeoutSeconds: 840,
  environment: {
    // Invokes the AgentCore Harness via its Cognito-JWT-authenticated
    // /harnesses/invoke endpoint (same path as the invoke-agent Lambda),
    // not the SigV4 runtime — the harness authorizes with CUSTOM_JWT.
    HARNESS_ARN: '',
    COGNITO_CLIENT_ID: '',
    SERVICE_ACCOUNT_USERNAME: '',
    SERVICE_ACCOUNT_SSM_PATH: '',
  },
});
