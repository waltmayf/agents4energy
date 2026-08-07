import { defineFunction } from '@aws-amplify/backend';

export const registerMcpTargetStream = defineFunction({
  name: 'register-mcp-target-stream',
  entry: './handler.ts',
  environment: {
    GATEWAY_ID: process.env.GATEWAY_ID ?? '',
    // Table name will be injected via backend.ts env below.
    MCP_SERVER_TABLE_NAME: process.env.MCP_SERVER_TABLE_NAME ?? '',
  },
});
