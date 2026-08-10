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
  "checkCommand": "bash -c \"gh pr checks 123 --repo owner/repo --json state --jq 'any(.[]; .state==\\\"SUCCESS\\\")' | grep -q true\"",
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

> **`checkCommand` runs with NO shell — wrap anything using a pipe, `&&`, or
> quoting in `bash -c "..."`.** `RunMonitorCheck` passes `checkCommand` straight
> to `InvokeAgentRuntimeCommand`, which execs it as a single command with its
> raw string split into argv — it does **not** go through `/bin/sh`. A command
> like `gh api ... --jq '...' | grep -q x` gets `|`, `grep`, and `-q` handed to
> `gh` as literal extra arguments (confirmed end-to-end, issue #263: this
> exact mistake made every check exit 1 with `gh`'s `accepts 1 arg(s), received
> 4`). Always wrap multi-command checks in `bash -c "<command>"` as shown above.

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
- **`checkCommand` execs have `git`'s credential store but not `gh`'s own auth.**
  `githubToken`/`GH_TOKEN` is wired into the environment of the `claude` CLI
  process `server.js` spawns for the agent's own turn, but `RunMonitorCheck`'s
  `InvokeAgentRuntimeCommand` exec gets a fresh environment without it
  (confirmed end-to-end: a `gh api ...` check failed asking for `gh auth
  login`). The **git** credential store `setupWorkspace()` seeds at clone time
  (`~/.git-credentials`) *is* still on disk and works fine for plain
  `git`/HTTPS operations (`git ls-remote https://github.com/...` succeeds) —
  it's specifically the `gh` CLI's own auth config that's missing. So a
  `checkCommand` that needs the GitHub API should use `curl` (unauthenticated
  for public repos; rate-limited without a token) or plain `git`, not `gh`.

## Debugging a monitor run

`RunMonitorCheck` (`web/amplify/functions/agent-webhook-monitor-check/handler.ts`)
runs `checkCommand` via `InvokeAgentRuntimeCommand` against the ClaudeCode
runtime ARN, with `runtimeSessionId` set to the run's `runId` — the same
session the original turn and every re-invoke use. Each tick:

- writes `monitor check iteration <n> running: <checkCommand>` and, after the
  exec completes, `exitCode=<n> conditionMet=<bool>` (plus truncated
  stdout/stderr) to **the run's own CloudWatch Logs stream** — the same stream
  the initial comment's Live Tail link points at, so a monitor's check history
  is visible right alongside the original turn's output;
- also logs the full stdout/stderr to the Lambda's own log group
  (`/aws/lambda/agent-webhook-monitor-check`) for deeper debugging.
- The exec itself is bounded to 90s (below the Lambda's own 120s timeout, so a
  hung check surfaces as a non-zero result the loop can interpret, not an
  unhandled Lambda timeout); the `RunMonitorCheck` task itself carries a 2-minute
  `taskTimeout`.

Reading the SFN execution graph (console or `aws stepfunctions
describe-execution` / `get-execution-history`) shows the `MonitorWait` →
`RunMonitorCheck` → `RouteCheck` states repeating once per tick — this is the
quickest way to confirm ticks are actually happening and see each one's timing.

## Where the code lives

- `agent/default/app/ClaudeCode/detect-monitor.js` — parses/validates the
  ```monitor``` block; `server.js` emits `agentStatus: 'monitoring'` (and its
  `--append-system-prompt` "MONITOR HANDOFF" block is what teaches the agent
  the block schema and the microVM-reclaim constraint in the first place).
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
