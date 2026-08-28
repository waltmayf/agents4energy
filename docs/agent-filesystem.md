# Agent Filesystem (S3-backed)

Issue #240 gives the chat harness agent an ergonomic filesystem it can read and write, backed by one S3 bucket (Amplify Storage) and exposed through five tools on the AgentCore Gateway: `ApplyDiff`, `ListFiles`, `ReadFile`, `DeleteFile`, `UploadFile` (the last added in #511, part of epic #498's shared-upload-lib slice — see [`docs/hpc-analytics-agents-epic.md`](hpc-analytics-agents-epic.md#slice-1--shared-upload-lib--uploadfile-tool-no-deps)).

This lets an agent read shared domain documentation and write business outputs (reports, analytic outputs) into a shared file space, treating S3 like a local filesystem.

## Path model

Every path — absolute or relative — resolves under a single root prefix, `files/`, in the `agentWorkspace` bucket. There is no per-prefix special-casing and no per-session isolation: all authenticated users and all chat sessions share this one space.

- **Absolute paths** (leading `/`) resolve from the filesystem root: `/docs/production/gas_lift.md` → S3 key `files/docs/production/gas_lift.md`.
- **Relative paths** (no leading `/`) resolve from the *same* root: `reports/q3.md` → S3 key `files/reports/q3.md`. Absolute and relative paths for the same segments resolve to the identical key.
- `.`/`..` segments are normalized. The only guard is **path traversal**: any path that would resolve above the `files/` root is rejected (`S3FsPathError`).

See `web/lib/s3-fs-path.ts` (and its tests) for the exact resolution logic.

**Convention, not enforcement:** seeded/shared domain documentation lives under `files/docs/...` by convention. This is *not* a separate enforced prefix and is *not* read-only — the tools can read and write anywhere under `files/`. Business outputs, reports, and scratch files can live anywhere else under `files/`, e.g. `files/reports/...`.

**No per-session working directory.** This was considered and dropped: the AgentCore Gateway invokes a Lambda target with only the tool's argument values (`event`) and fixed gateway/target/tool metadata (`context`) — it does not forward the harness's `runtimeSessionId`, the caller's identity, or inbound request headers to a Lambda target. Threading a session id through would require either making it an explicit tool argument (which the model would need to supply correctly on every call) or an HTTP MCP-server target with a request interceptor — both out of scope here. If per-session sandboxing is wanted later, it needs its own design.

## Tools

### `ApplyDiff` — create or modify a file

Args: `path` (string, required), `diff` (string, required).

Accepts one or more **SEARCH/REPLACE blocks** (the Aider / Cline / Roo-Code `apply_diff` style), applied server-side with fuzzy matching:

```
<<<<<<< SEARCH
:start_line:<N>          (optional hint; the applier does NOT trust it)
-------
<exact existing content, including whitespace/indentation>
=======
<replacement content>
>>>>>>> REPLACE
```

This format is content-keyed rather than line-number-keyed — models are unreliable with line-number math (that's why unified diff / `@@ -n,m` hunks are deliberately *not* supported here). Rules:

- Multiple blocks may appear in one `diff`; they're applied top-to-bottom against the evolving buffer.
- Matching tries an exact substring match first; if that's ambiguous (multiple matches) or absent, it falls back to a normalized, similarity-scored search (default threshold: exact match only, i.e. `1.0`), preferring the `:start_line:` hint's neighborhood, then the file middle.
- An **empty SEARCH block** against a non-existent `path` creates the file with the REPLACE body as its full content.
- Errors are actionable: `"no match found for SEARCH block N"` or `"SEARCH block N matched M locations — add more surrounding context"`.

See `web/lib/s3-fs-diff.ts` (and its tests) for the parser/applier implementation.

### `ListFiles` — list a "directory"

Args: `path` (string, optional — a prefix; defaults to the `files/` root), `recursive` (boolean, optional, default `false`).

Returns a listing distinguishing files from sub-"directories" (S3 common prefixes under `Delimiter: '/'`), with file sizes.

### `ReadFile` — read a file's contents

Args: `path` (string, required). Returns the file's contents as text. Reads are capped at 1 MiB (large enough for any doc/report an agent would reasonably read/write by hand, small enough to stay within the harness's context budget) — a file over that limit returns a clear error instead of truncating silently. Not-found also returns a clear error.

### `DeleteFile` — delete a file

Args: `path` (string, required). Deletes the object; returns a clear error if it doesn't exist.

### `UploadFile` — write or copy a file, without going through `ApplyDiff`

Args: `destPath` (string, required, under `files/`) plus **exactly one** of `sourcePath`
(string — an existing `files/` key to server-side-copy) or `content` (string — inline data to
write directly), and an optional `encoding` (`'utf-8'` (default) or `'base64'`, only meaningful
with `content`).

- **`content`** → `uploadObjectBytes()` does a `PutObject` of the decoded bytes to `destPath`,
  with the content-type sniffed from the destination's extension (`.html`, `.csv`, `.json`,
  `.txt`, `.png`). Use `encoding: 'base64'` for binary payloads (e.g. an image) that can't
  round-trip as UTF-8 text.
- **`sourcePath`** → `copyObjectWithinFs()` does a server-side `CopyObject` from one existing
  `files/` key to another — the "upload from an existing file" case for a Lambda that has no
  local disk of its own to upload *from*.
- Providing both or neither of `sourcePath`/`content` is a validation error, not a silent
  fallback.

`UploadFile` shares its implementation
([`web/lib/s3-fs-upload.ts`](../web/lib/s3-fs-upload.ts)) with the Athena PySpark tool's
in-session auto-upload — see [`docs/analytics-agent.md`](analytics-agent.md#artifact-rendering-under-filesartifacts)
for how that composability works without an MCP-to-MCP call. Both call sites resolve paths
through the same `resolveS3Path`/`resolveArtifactsPrefix` normalization and `../`-traversal
guard as every other tool in this file.

## Wiring

- **Storage**: `web/amplify/storage/resource.ts` — the `agentWorkspace` Amplify Storage bucket.
- **Lambda**: `web/amplify/functions/s3-tools/handler.ts` — dispatches on `context.clientContext.custom.bedrockAgentCoreToolName` (form `<gatewayTargetName>___<ToolName>`), since one Lambda backs all five tools.
- **Gateway target**: `web/amplify/constructs/s3ToolsGatewayTarget/` — a CDK custom resource that calls `CreateGatewayTarget` with a Lambda target configuration and an inline tool schema.
- **Demo Agent/McpServer**: `web/amplify/constructs/s3ToolsMcpServerSeed/` — a CDK custom resource that idempotently seeds a demo `Agent` + `McpServer` + `AgentMcpServer` join so the tools are reachable from the chat UI without manual setup.

See [`docs/agentic-architecture.md`](./agentic-architecture.md#lambda-backed-gateway-target-s3-filesystem-tools) for how this fits into the rest of the MCP tool wiring.

## Browser upload page (`/files`)

Issue #372 adds `web/app/(with-auth)/files/page.tsx`, a signed-in-only page for managing this same bucket/prefix directly from the browser via the Amplify Storage SDK (`list`, `uploadData`, `getUrl`, `remove` from `aws-amplify/storage`) rather than through the agent's tools. Because it's the identical `agentWorkspace` bucket and `files/` root, anything uploaded there is immediately visible to `ReadFile`/`ListFiles`, and anything the agent writes shows up in the page on refresh.

- **Flat space, matches the tool model.** The page lists, uploads, downloads, and deletes against the shared `files/` root using `resolveS3Prefix(null)` from `web/lib/s3-fs-path.ts` — no per-user namespacing, no folder browser. `list()` recurses, so nested keys (e.g. `files/docs/...`) show up as flat rows with their full relative path.
- **Access control.** Browser writes are authorized by the `files/*` Storage grant in `web/amplify/storage/resource.ts` (`allow.authenticated.to(['read', 'write', 'delete'])`, extended from read-only by #373) — any signed-in user, no additional per-file ACL.
- **No client-side size/type restrictions** — this is a dev-velocity default, not a permanent constraint; revisit if abuse or oversized uploads become a problem.

## Out of scope (follow-up work)

- Seeding actual `files/docs/...` domain content (e.g. artificial-lift documentation) — this issue delivers the *capability*, not the content.
- Per-session/per-user isolation — all sessions/users share the single `files/` space.
