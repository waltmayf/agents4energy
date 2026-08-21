# Worker progress peek

The orchestrator can obtain a bounded view of a worker's live transcript via the existing `list-session-messages` GraphQL Lambda.

## Usage

Call the Lambda (or the generated AppSync query) with:

```json
{
  "arguments": {
    "sessionId": "<run-id>",
    "actorId": "default", // or the webhook actor ID if needed
    "limit": 10            // optional – number of most‑recent messages to return
  }
}
```

The response includes an `events` array limited to the most recent `limit` messages (or the full transcript if omitted). This provides a concise progress digest without exhausting the orchestrator's token budget.

## Actor ID

When a worker is dispatched via the webhook, its messages are stored under the **shared actor namespace** (`SHARED_ACTOR_ID`). The orchestrator should use that value (available in the webhook comment) or the default `default` if appropriate. The `list-session-messages` Lambda now enforces authorization against the caller’s Cognito sub and the shared namespace.

## Practical tip

In an orchestrator turn, after extracting the `run <runId>` from the dispatched issue comment, invoke the above query with a modest `limit` (e.g., `5` or `10`). The returned `events` can be inspected to decide whether the worker appears stalled, has completed work, or needs re‑dispatch.
