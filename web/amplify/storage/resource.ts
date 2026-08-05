import { defineStorage } from '@aws-amplify/backend';

// S3-backed filesystem for the agent's ApplyDiff/ListFiles/ReadFile/DeleteFile
// tools (issue #240). Two areas in this one bucket:
//   docs/                      — shared, read-mostly documentation (absolute paths)
//   workspace/id=<sessionId>/  — per-chat-session read+write scratch space
// Access is granted directly to the s3-tools Lambda's execution role in
// backend.ts (scoped s3:GetObject/PutObject/DeleteObject/ListBucket), not via
// this construct's `access` builder — there is no direct browser/Cognito
// access to this bucket.
export const agentWorkspace = defineStorage({
  name: 'agentWorkspace',
});
