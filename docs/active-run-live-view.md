# ActiveRun Live View

How a viewer who opens (or is already watching) a chat session sees the assistant's message *while it is still streaming*, instead of nothing until the turn finishes and lands in AgentCore Memory.

## Why this exists

The harness persists a turn to `MyHarnessMemory` only once the message is complete (see [agentic-architecture.md](agentic-architecture.md)). Cross-viewer sync (`web/app/(with-auth)/chat/use-session-message-polling.ts` → `refreshHistory()` → `loadHistory()`) reads that memory, so a second tab or a late-joining viewer previously saw nothing for the in-flight message until it was fully indexed. `ActiveRun` closes that gap with a throttled, short-lived snapshot row that a viewer's history load can render as a synthetic in-flight bubble.

Design background: issue #15 (option 2 — server-side/browser running snapshot) and issue #17.

## The `ActiveRun` model

Defined in `web/amplify/data/schemas/chat.schema.ts`:

| Field | Purpose |
|---|---|
| `sessionId` | One row per chat session (the AgentCore `runtimeSessionId`) |
| `messageId` | The AG-UI message id of the message currently streaming — **must match** the id `TEXT_MESSAGE_START` uses, so a later real persist with the same id supersedes the snapshot instead of duplicating it |
| `accumulatedText` | The assistant text accumulated so far |
| `status` | `'streaming'` while a turn is in flight; the row is deleted (not set to `'done'`) once the turn finishes |
| `updatedAt` | Last write time — used by the consumer's staleness guard |

Auth: `[allow.owner(), allow.authenticated(), allow.guest()]` — the browser producer and viewers are both Cognito principals, so no IAM/backend auth is required for this slice.

## Producer: browser throttled write (`web/lib/harness-agent.ts`)

`HarnessAgent.run()` already translates the raw harness Converse stream into AG-UI `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` events (via `translateHarnessStreamEvent`) as it forwards them to the UI. The producer piggybacks on those same events rather than re-parsing the raw stream:

- On `TEXT_MESSAGE_START`, it captures the new message's id and resets the accumulated text.
- On `TEXT_MESSAGE_CONTENT`, it appends the delta to the accumulated text.
- At most once every ~750ms (a simple `lastWrite` timestamp check inside the streaming loop — no background timers that could outlive the run), it calls `upsertActiveRun()` (`web/lib/active-run.ts`) with the accumulated text and `status: 'streaming'`. The returned row id is cached so later writes in the same run update by id instead of re-listing.
- Right before the run finishes, it flushes one final write with the complete accumulated text, then calls `clearActiveRun(sessionId)` so the persisted memory version (now available) becomes the source of truth again.
- The snapshot is also cleared on the error path and on teardown/cancel (stop button / unsubscribe), so an aborted run doesn't leave a stale "streaming" row behind in the common case.

All of this is best-effort: `upsertActiveRun`/`clearActiveRun` swallow and log their own errors — a failed snapshot write must never break the live stream the user is actually watching.

## Consumer: `loadHistory()` in-flight bubble (`web/lib/harness-agent.ts`)

After building the persisted-message list from `listSessionMessages`, `loadHistory()` calls `fetchActiveRun(sessionId)` and appends a synthetic assistant message from the snapshot when:

- a row exists with `status === 'streaming'` and non-empty `accumulatedText`,
- its `messageId` isn't already present in the persisted list (once the real message lands in memory, the persisted copy wins and the snapshot is skipped), and
- the row isn't stale (see below).

The synthetic message uses `messageId` as its own id, so a subsequent reload that finds the same id in the persisted transcript naturally replaces it rather than duplicating it.

Any error fetching the `ActiveRun` row is caught and logged — history loading always falls back to the persisted list.

## Staleness guard

A browser tab that crashes or loses network mid-stream never reaches the `clearActiveRun()` call, leaving a `status: 'streaming'` row with no one left to clean it up. `loadHistory()` guards against this by ignoring any `ActiveRun` row whose `updatedAt` is more than 60 seconds old (or missing/unparseable) — preventing a permanently stuck in-flight bubble for other viewers.

## Producer: server-side throttled write (`agent/default/app/ClaudeCode/`)

The browser producer above covers only a user with the chat page open, streaming a turn themselves. #15's core scenario — a browserless run started via `@agentcore-claude` (or any process-driven invocation of the ClaudeCode AgentCore runtime) whose in-flight text no browser is producing — needs a **server-side producer** running inside that runtime.

An earlier iteration (#232, now reverted) tried to reach `ActiveRun` through a `write-active-run` Amplify Lambda, reasoning that the runtime's execution role isn't a Cognito principal and `allow.authenticated()` maps to the identity-pool role, not an arbitrary IAM role (see PR #230's rejection of injecting the role directly). That reasoning about Cognito was right, but the fix was the wrong shape: the runtime doesn't need to *become* a Cognito principal or go through a Lambda auth adapter — it's already a perfectly valid IAM principal, and AppSync accepts IAM (SigV4) auth directly. `allow.resource(fn)` is a convenience for `defineFunction` Lambdas, not a requirement for programmatic API access — exactly the same way `scripts/graphql.sh` calls the API locally with a developer's own IAM credentials.

So the runtime calls AppSync's GraphQL endpoint directly, over HTTPS, signing each request with SigV4:

- **`agent/default/app/ClaudeCode/active-run.js`** — `upsertActiveRun()` / `clearActiveRun()`, mirroring `web/lib/active-run.ts`'s semantics byte-for-byte (list-by-`sessionId` → update-if-found-else-create; delete on clear) using raw `listActiveRuns`/`createActiveRun`/`updateActiveRun`/`deleteActiveRun` GraphQL operations, signed with `@aws-sdk/signature-v4` + `@aws-crypto/sha256-js` against `@aws-sdk/credential-providers`' `fromNodeProviderChain()` (the runtime's own ambient execution-role credentials — no Cognito involved).
- **`agent/default/app/ClaudeCode/server.js`** — hooks into the `stream-json` loop right where `persistClaudeStreamEvent()` already runs: accumulates assistant `text` blocks across events, throttle-writes (~750ms, trailing-edge) via `upsertActiveRun()`, and on the terminal `result` event (or an error/close) flushes a final write then calls `clearActiveRun()` so the row never outlives the job. `sessionId` is `memorySessionId` (the same id memory events use — see `docs/webhook-stepfunction-integration.md`). All best-effort: every call swallows and logs its own errors, exactly like the browser producer and every other memory write in this runtime.

### Cycle-safe wiring (`web/amplify/backend.ts` + `scripts/build.sh`)

Two constraints drove the wiring:

1. **No reference from the agent stack to a data-stack token.** Granting IAM permissions on the *real* AppSync API ARN (`backend.data`'s CFN token) from the agent stack's runtime role would create a `data → function → agent → data` CloudFormation cycle (this killed an earlier PR, #230, twice). So `backend.ts` grants `appsync:GraphQL` and `ssm:GetParameter` using **wildcard string ARNs** (`arn:aws:appsync:*:*:apis/*/types/Query/fields/*` and `.../types/Mutation/fields/*`, `arn:aws:ssm:*:*:parameter/outputs/*`) — plain strings with no CDK token, matching the existing `states:SendTaskSuccess/Failure` grant's own comment ("no cross-stack token cycle"). Both `Query` and `Mutation` are granted because `active-run.js` does a list-then-upsert (`listActiveRuns` is a Query field, `create/update/deleteActiveRun` are Mutations).
2. **No data-stack value baked into a CDK env var.** The GraphQL URL only exists after `ampx sandbox` synthesizes the data stack — encoding it as `agentCoreApp.addRuntimeEnvironmentVariable(...)` would reference that same token. Instead, `scripts/build.sh` publishes `{ url, region }` (read back from its own `amplify_outputs.json`, `.data.url` / `.data.aws_region`) to SSM at `/outputs/<repoSlug>/<branchSlug>/activerun-graphql` with `--overwrite`, after the sandbox deploy — the same idempotent, self-healing pattern the neighboring e2e-config publish already uses (see that block's comment for why: issue #192). `backend.ts` computes the identical path from `process.env.GITHUB_REPOSITORY` + the `backendName` CDK context value (both plain strings) and passes it to the runtime as the `ACTIVERUN_GRAPHQL_SSM_PATH` env var, so build.sh and backend.ts can't drift out of sync on the path itself.

`active-run.js` reads that env var at startup, fetches the parameter once per process (cached), and no-ops (logs + skips every write) if it's absent — e.g. a local `agentcore dev` run against a branch that hasn't been through `scripts/build.sh` yet.
