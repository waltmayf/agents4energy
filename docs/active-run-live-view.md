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

## What's deferred

This slice covers the **browser producer only** — a user with the chat page open, streaming a turn themselves. #15's core scenario — a browserless ClaudeCode/webhook run whose in-flight text no browser is producing — needs a **server-side producer**, which can't write AppSync directly from the AgentCore container runtime (its IAM role isn't a Cognito principal, and `allow.authenticated()` maps to the identity-pool role, not an arbitrary execution role — see PR #230). The chosen approach is to write *through the API*, via an Amplify `defineFunction` granted `allow.resource()` data access, split into two independently-deployable slices:

- **Slice A (landed):** the writer Lambda — `web/amplify/functions/write-active-run/`. Registered in `defineBackend(...)` and granted `allow.resource(writeActiveRun).to(['mutate'])` on the chat schema (the schema object that owns `ActiveRun` — function access can only be configured on a schema, not a model/field). Nothing invokes it yet.
- **Slice B (follow-up, not yet started):** wire the ClaudeCode runtime to invoke this Lambda — tokenless function-name delivery, an `lambda:InvokeFunction` grant, and a throttled write from `server.js`. This is the cycle-sensitive part: it must NOT add a reference from the agent stack back to the Lambda in a way that reintroduces a data-stack value (GraphQL URL/ARN, table name/ARN) into the AgentCore runtime.

### Slice A's contract: `write-active-run` Lambda

Not wired into `defineBackend`'s function URL or any resolver — it's invoked directly (`lambda:invoke`) once Slice B wires a caller. Request shape:

```ts
{
  sessionId: string;
  messageId: string;
  accumulatedText: string;
  status: 'streaming' | 'done';
  clear?: boolean; // force a delete even if status is 'streaming'
}
```

Response: `{ ok: boolean; id?: string }`. On `status: 'streaming'` it upserts the session's single `ActiveRun` row (list by `sessionId`, update if found else create), matching `web/lib/active-run.ts`'s semantics byte-for-byte so browser- and server-produced snapshots are interchangeable for the consumer in `loadHistory()`. On `status: 'done'` (or `clear: true`) it deletes the session's row(s). Write errors are logged and swallowed — `{ ok: false }` — never thrown, so a snapshot failure can never crash the caller. The core upsert/clear logic lives in `logic.ts` as `writeActiveRunWithClient`, a pure function parameterized on the data client, so it's unit-tested (`handler.test.ts`) without needing the `$amplify/env/write-active-run` shim that only exists after a synth/deploy.
