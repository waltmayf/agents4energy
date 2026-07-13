import { defineFunction } from '@aws-amplify/backend';

export const agentWebhookInvokeAgent = defineFunction({
  name: 'agent-webhook-invoke-agent',
  entry: './handler.ts',
  timeoutSeconds: 840,
  environment: {
    // Invokes the AgentCore Harness via the SDK's InvokeHarnessCommand and the
    // pre-invoke git-auth exec via InvokeAgentRuntimeCommand — both SigV4-signed
    // with this Lambda's execution role, since the harness authorizes with
    // AWS_IAM. No Cognito service account / SSM password anymore.
    HARNESS_ARN: '',
  },
});
