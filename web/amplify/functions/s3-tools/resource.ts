import { defineFunction } from '@aws-amplify/backend';

// Gateway-target Lambda backing the ApplyDiff/ListFiles/ReadFile/DeleteFile
// agent filesystem tools (issue #240). Invoked directly by the AgentCore
// Gateway (Lambda-backed MCP target), not via AppSync — BUCKET_NAME is set in
// backend.ts once the Amplify Storage bucket exists.
export const s3Tools = defineFunction({
  name: 's3-tools',
  entry: './handler.ts',
  timeoutSeconds: 30,
  environment: {
    BUCKET_NAME: '',
  },
});
