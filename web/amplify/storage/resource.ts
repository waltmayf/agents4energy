import { defineStorage } from '@aws-amplify/backend';

// S3-backed filesystem for the agent's ApplyDiff/ListFiles/ReadFile/DeleteFile
// tools (issue #240). Everything lives under a single `files/` root prefix
// that every session/user shares — see web/lib/s3-fs-path.ts for path
// resolution. Seeded domain documentation lives under `files/docs/...` by
// convention only (not a separate enforced prefix, not read-only).
//
// The s3-tools Lambda's execution role also has direct write access, granted
// in backend.ts (scoped s3:GetObject/PutObject/DeleteObject/ListBucket).
// The authenticated grant below gives signed-in users full CRUD (read,
// write, delete) on the same `files/*` prefix (issue #373, extending the
// read-only grant from #348) — this backs both the knowledge-graph
// explorer's presigned GET via `getUrl` (#332) and browser-side
// upload/delete via `uploadData`/`remove` (#372). Anything a user writes
// here is immediately visible to the agent's ReadFile/ListFiles tools, since
// it's the same bucket and prefix. Unauthenticated/guest access remains
// denied.
export const agentWorkspace = defineStorage({
  name: 'agentWorkspace',
  access: (allow) => ({
    'files/*': [allow.authenticated.to(['read', 'write', 'delete'])],
  }),
});
