# Monitor loop: Claude → Step Functions hand-off

The **monitor loop** lets an `@agentcore-claude` run pause itself and be
automatically re-invoked when a condition it defines becomes true — without
holding any runtime compute while it waits. It is the webhook state machine's
answer to "keep an eye on X and continue when it's ready" (e.g. *wait for CI to
go green on this PR, then address any failures*).

Epic #260, delivered in three slices:

| Slice | Issue | What |
|-------|-------|------|
| 1/3 | #261 | Runtime detects a ```monitor``` block in the agent's final message and resumes the paused SFN task with `agentStatus: 'monitoring'` + `monitorSpec`. |
| 2/3 | #262 | State machine enters a **Wait → RunMonitorCheck → Choice** loop that re-invokes Claude when the check passes. |
| 3/3 | #263 | Docs (this file) + end-to-end deploy/test. |

## How a run hands off to a monitor

At the end of its turn, the agent emits a fenced ```monitor``` block whose body
is JSON:

````
```monitor
{
  "intervalSeconds": 60,
  "maxIterations": 10,
  "checkCommand": "gh pr checks 123 --repo owner/repo --json state --jq 'any(.[]; .state==\"SUCCESS\")' | grep -q true",
  "followUpPrompt": "CI is now green on PR #123. Review the run and address any remaining review comments."
}
```
````

`agent/default/app/ClaudeCode/detect-monitor.js` parses and validates it:

- **`checkCommand`** and **`followUpPrompt`** are **required**. A block missing
  either (or with malformed JSON) is ignored — the run completes normally rather
  than stranding itself in a monitor with no exit.
- **`intervalSeconds`** — how long to wait between checks. Clamped to
  **[30, 900]**, default **60**.
- **`maxIterations`** — how many checks before giving up. Clamped to **[1, 40]**,
  default **10**.

When a valid block is present, the runtime resumes the paused Step Functions
task (`SendTaskSuccess`) with `{ agentStatus: 'monitoring', monitorSpec: {…} }`
instead of a normal completion.

## The state-machine loop (#262)

`RouteAgentResult` (the Choice after `InvokeClaude`) branches on `agentStatus`:

- `awaiting_input` → `PostAwaitingInputComment` (the run asked the user a question)
- `monitoring` → **the loop below**
- otherwise → `PostFinalComment` (normal completion)

```
InvokeClaude (WAIT_FOR_TASK_TOKEN)
      │  agentStatus == 'monitoring'
      ▼
InitMonitor (Pass)          $.monitor = { iteration: 0, spec: $.agentResult.monitorSpec }
      ▼
MonitorWait (Wait) ◀───────────────────────┐   SecondsPath: $.monitor.spec.intervalSeconds
      ▼                                     │   ← NO runtime compute held here
RunMonitorCheck (Lambda)                    │   runs checkCommand in the SAME runtime session
      │  { conditionMet, exitCode, … }      │
      ▼                                     │
RouteCheck (Choice)                         │
   ├─ conditionMet == true ─► PrepareMonitorReinvoke (Pass) ─► InvokeClaude   (re-invoke w/ followUpPrompt)
   ├─ iteration >= maxIterations ─► PostMonitorStoppedComment (final, non-error)
   └─ otherwise ─► IncrementIteration (Pass) ──────────────┘  (iteration + 1, loop back to Wait)
```

Key properties:

- **No pinned compute during `Wait`.** The `Wait` state holds no runtime — the
  AgentCore microVM is reclaimed on idle `/ping` between checks, so a monitor
  polling every 15 minutes for hours costs essentially nothing while idle. Only
  `RunMonitorCheck` (a short exec) and the re-invoked turn consume runtime.
- **Same session across the whole loop.** `RunMonitorCheck` and every re-invoke
  reuse the original `runId` as the `runtimeSessionId`, so the checked-out repo
  under `/mnt/workspace` and the agent's memory persist across ticks and
  re-invokes. **But** a fresh container may back the session on any given tick —
  write **self-contained** `checkCommand`s (absolute paths, no reliance on
  shell state from a previous tick).
- **Exit-code-0 convention.** `RunMonitorCheck` runs `checkCommand` via
  `InvokeAgentRuntimeCommand` and sets `conditionMet = (exitCode === 0)`. Write
  the check so it exits 0 exactly when you want the follow-up to fire.
- **Doubly bounded.** The loop stops at `maxIterations` (spec) **and** is capped
  by the state machine's 4h `timeout`. A never-satisfied monitor posts a
  "Monitoring stopped after N check(s)…" comment (non-error) rather than looping
  forever.
- **Transient check failures don't kill the run.** If `RunMonitorCheck` itself
  errors (an exec hiccup, not a non-zero exit), its `Catch` routes to
  `IncrementIteration` — the tick is treated as "not yet met" and the loop
  continues, costing one interval rather than stamping `agent-error`.
- **Cancellation still works.** A monitor execution is `RUNNING` (paused in
  `Wait` or at the check task), so a superseding `@agentcore-claude` comment's
  last-write-wins `StopExecution` (issue #182) reaches and cancels it.

## Where the code lives

- `agent/default/app/ClaudeCode/detect-monitor.js` — parses/validates the
  ```monitor``` block; `server.js` emits `agentStatus: 'monitoring'`.
- `web/amplify/constructs/agentWebhookStack.ts` — the `RouteAgentResult` Choice
  and the `InitMonitor` / `MonitorWait` / `RunMonitorCheck` / `RouteCheck` /
  `PrepareMonitorReinvoke` / `IncrementIteration` / `PostMonitorStoppedComment`
  states.
- `web/amplify/functions/agent-webhook-monitor-check/` — the `RunMonitorCheck`
  Lambda (runs `checkCommand` in the runtime session, returns `conditionMet`).
- `web/amplify/backend.ts` — wires the Lambda, its `CLAUDE_CODE_RUNTIME_ARN`
  env, and its `InvokeAgentRuntime` grant (same shape as the invoke-claude
  branch).

See [webhook-stepfunction-integration.md](webhook-stepfunction-integration.md)
for the surrounding webhook → Step Functions pipeline.
