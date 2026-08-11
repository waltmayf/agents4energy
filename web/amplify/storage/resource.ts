import { defineStorage } from '@aws-amplify/backend';

// S3-backed filesystem for the agent's ApplyDiff/ListFiles/ReadFile/DeleteFile
// tools (issue #240). Everything lives under a single `files/` root prefix
// that every session/user shares — see web/lib/s3-fs-path.ts for path
// resolution. Seeded domain documentation lives under `files/docs/...` by
// convention only (not a separate enforced prefix, not read-only).
//
// Write access is granted directly to the s3-tools Lambda's execution role in
// backend.ts (scoped s3:GetObject/PutObject/DeleteObject/ListBucket) — the
// browser never writes here. The authenticated-read grant below (issue #348)
// lets signed-in users mint a client-side presigned GET URL via Amplify
// Storage `getUrl` so the knowledge-graph explorer (#332) can open the S3
// object linked to a graph node (node `props.s3Path`, a `files/`-relative
// path). Read-only, scoped to the same `files/` root prefix.
export const agentWorkspace = defineStorage({
  name: 'agentWorkspace',
  access: (allow) => ({
    'files/*': [allow.authenticated.to(['read'])],
  }),
});
