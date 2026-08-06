import { defineFunction } from '@aws-amplify/backend';

export const syncCedarPolicies = defineFunction({
  name: 'sync-cedar-policies',
  entry: './handler.ts',
  timeoutSeconds: 60,
  environment: {
    POLICY_ENGINE_ID: process.env.POLICY_ENGINE_ID ?? '',
    GATEWAY_ID: process.env.GATEWAY_ID ?? '',
    GROUP_TOOL_GRANT_TABLE_NAME: process.env.GROUP_TOOL_GRANT_TABLE_NAME ?? '',
    MCP_SERVER_TABLE_NAME: process.env.MCP_SERVER_TABLE_NAME ?? '',
  },
});
