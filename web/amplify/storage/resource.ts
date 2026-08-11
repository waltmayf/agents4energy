import { defineStorage } from '@aws-amplify/backend';

// S3-backed filesystem for the agent's ApplyDiff/ListFiles/ReadFile/DeleteFile
// tools (issue #240). Everything lives under a single `files/` root prefix
// that every session/user shares — see web/lib/s3-fs-path.ts for path
// resolution. Seeded domain documentation lives under `files/docs/...` by
// convention only (not a separate enforced prefix, not read-only).
// Access is granted directly to the s3-tools Lambda's execution role in
// backend.ts (scoped s3:GetObject/PutObject/DeleteObject/ListBucket), not via
// this construct's `access` builder — there is no direct browser/Cognito
// access to this bucket.
export const agentWorkspace = defineStorage({
  name: 'agentWorkspace',
  access: (allow) => ({
    'files/*': [allow.authenticated.to(['read'])],
  }),
});
