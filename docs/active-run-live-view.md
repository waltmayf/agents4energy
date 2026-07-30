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

This slice covers the **browser producer only** — a user with the chat page open, streaming a turn themselves. A server-side/webhook producer (the ClaudeCode AgentCore runtime writing its own `ActiveRun` snapshot via SigV4 while running unattended) is a separate, larger follow-up: it requires wiring the AppSync endpoint and IAM mutation permissions into the runtime, which is out of scope here to keep this change client-only and free of new CloudFormation stack dependencies.
