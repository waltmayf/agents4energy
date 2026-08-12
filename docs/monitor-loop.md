# Monitor loop: Claude → Step Functions hand-off

The **monitor loop** lets an `@agentcore-claude` run pause itself and be
automatically re-invoked when a condition it defines becomes true — without
holding any runtime compute while it waits. It is the webhook state machine's
answer to "keep an eye on X and continue when it's ready" (e.g. *wait for CI to
go green on this PR, then address any failures*).

Epic #260, delivered in these slices:

| Slice | Issue | What |
|-------|-------|------|
| 1/3 | #261 | Runtime detects a ```monitor``` block in the agent's final message and resumes the paused SFN task with `agentStatus: 'monitoring'` + `monitorSpec`. |
| 2/3 | #262 | State machine enters a **Wait → RunMonitorCheck → Choice** loop that re-invokes Claude when the check passes. |
| 3/3 | #263 | Docs (this file) + end-to-end deploy/test. |
| — | #377 | **Timed wait**: a second `monitorSpec` shape with no `checkCommand` — a single long `Wait` (up to the SFN max) followed directly by a re-invoke, for "pause for N seconds, then continue" rather than "poll until a condition is true". Also raised the condition-poll `intervalSeconds` clamp to match. |

## How a run hands off to a monitor

At the end of its turn, the agent emits a fenced ```monitor``` block whose body
is JSON, in one of two shapes:

### Shape 1 — condition poll (`checkCommand` present)

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

Wakes as soon as `checkCommand` exits 0, polling every `intervalSeconds` up to
`maxIterations` times.

### Shape 2 — timed wait, no condition (#377)

````
```monitor
{
  "waitSeconds": 10800,
  "followUpPrompt": "3 hours should be enough for workers to deliver — check the review queue and act on whatever landed."
}
```
````

No `checkCommand` at all: a single unconditional `Wait(waitSeconds)`, then a
re-invoke with `followUpPrompt` — no polling, no `maxIterations`. This is the
shape for "pause for N seconds/hours, then continue" — e.g. the epic-delivery
loop giving dispatched workers a fixed window before checking back in.

### Validation

`agent/default/app/ClaudeCode/detect-monitor.js` parses and validates the
block:

- **`followUpPrompt`** is **required** in both shapes. A block missing it (or
  with malformed JSON, or no block at all) is ignored — the run completes
  normally rather than stranding itself in a monitor with no exit.
- **`checkCommand`** is what distinguishes the two shapes: present → shape 1
  (condition poll); absent → shape 2 (timed wait).
- **`intervalSeconds`** (shape 1) / **`waitSeconds`** (shape 2, falling back to
  `intervalSeconds` if that's the field name used instead) — how long to wait.
  Clamped to **[30, 99999999]** (the Step Functions `Wait` state's own max,
  ~3.17 years), default **60**. Note the *practical* ceiling is much lower —
  see "Execution timeout" below.
- **`maxIterations`** (shape 1 only) — how many checks before giving up.
  Clamped to **[1, 40]**, default **10**.
- The validated spec is tagged `kind: 'condition' | 'timed'` so the state
  machine (`RouteMonitorKind`) can route it without re-deriving the shape.

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

## The state-machine loop (#262, extended by #377)

`RouteAgentResult` (the Choice after `InvokeClaude`) branches on `agentStatus`:

- `awaiting_input` → `PostAwaitingInputComment` (the run asked the user a question)
- `monitoring` → **the loop below**
- otherwise → `PostFinalComment` (normal completion)

`InitMonitor` seeds `$.monitor`, then `RouteMonitorKind` splits on
`$.monitor.spec.kind`:

```
InvokeClaude (WAIT_FOR_TASK_TOKEN)
      │  agentStatus == 'monitoring'
      ▼
InitMonitor (Pass)          $.monitor = { iteration: 0, spec: $.agentResult.monitorSpec }
      ▼
RouteMonitorKind (Choice)
      │
      ├─ kind == 'timed' ───────────────────────────────────────────────────┐
      │                                                                     ▼
      │                                                       TimedMonitorWait (Wait)
      │                                                       SecondsPath: $.monitor.spec.waitSeconds
      │                                                                     ▼
      │                                            PrepareTimedMonitorReinvoke (Pass) ─► InvokeClaude
      │                                                       (unconditional re-invoke w/ followUpPrompt —
      │                                                        no check, no maxIterations, no loop)
      │
      └─ otherwise (condition poll) ──────────────────────────┐
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

- **No pinned compute during either `Wait`.** Both `MonitorWait` and
  `TimedMonitorWait` hold no runtime — the AgentCore microVM is reclaimed on
  idle `/ping` while paused, so a monitor waiting hours (or, for a timed wait,
  much longer) costs essentially nothing while idle. Only `RunMonitorCheck` (a
  short exec, condition-poll only) and the re-invoked turn consume runtime.
- **A timed wait is a single hop, not a loop.** `RouteMonitorKind` sends a
  `kind: 'timed'` spec straight to `TimedMonitorWait` → an unconditional
  re-invoke — there's no `RunMonitorCheck`/`RouteCheck`/iteration counter for
  this shape, because there's no condition to check.
- **Same session across the whole loop (either shape).** `RunMonitorCheck` and
  every re-invoke reuse the original `runId` as the `runtimeSessionId`, so the
  checked-out repo under `/mnt/workspace` and the agent's memory persist across
  ticks and re-invokes. **But** a fresh container may back the session on any
  given tick — write **self-contained** `checkCommand`s (absolute paths, no
  reliance on shell state from a previous tick).
- **Exit-code-0 convention (condition poll only).** `RunMonitorCheck` runs
  `checkCommand` via `InvokeAgentRuntimeCommand` and sets
  `conditionMet = (exitCode === 0)`. Write the check so it exits 0 exactly when
  you want the follow-up to fire.
- **Doubly bounded (condition poll); singly bounded (timed wait).** The
  condition-poll loop stops at `maxIterations` (spec) **and** is capped by the
  state machine's execution `timeout`. A never-satisfied monitor posts a
  "Monitoring stopped after N check(s)…" comment (non-error) rather than
  looping forever. A timed wait has no `maxIterations` — it's bounded only by
  the execution `timeout` (see below).
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

## Execution timeout — the real ceiling on a long wait (#377)

`detect-monitor.js` clamps `intervalSeconds`/`waitSeconds` up to **99,999,999**
seconds (~3.17 years) to match the Step Functions `Wait` state's own maximum —
but that's not the number that actually bounds a monitor run in practice:

- The state machine's own `timeout` (the `timeout:` prop on the `StateMachine`
  construct in `agentWebhookStack.ts`) is **364 days**, set deliberately just
  under Step Functions' **hard, non-adjustable 1-year maximum execution time
  for Standard Workflows** (`States.Timeout` if exceeded — see the
  [Step Functions quotas](https://docs.aws.amazon.com/step-functions/latest/dg/limits-overview.html#service-limits-state-machine-executions)).
  A single `Wait` requesting more than that will still get scheduled (the
  `Wait` state itself doesn't validate against the execution timeout at
  schedule time), but the *execution* fails with `States.Timeout` once the
  1-year ceiling is hit, regardless of what `waitSeconds`/`intervalSeconds`
  asked for.
- The `InvokeClaude` task's own 3h `taskTimeout` does **not** bound the wait —
  it only bounds how long that one paused callback task can wait for
  `SendTaskSuccess`/`SendTaskFailure`. `MonitorWait`/`TimedMonitorWait` are
  separate `Wait` states the execution passes through *between* `InvokeClaude`
  attempts, each a fresh task once re-invoked, so a wait of any length (up to
  the execution timeout above) is unaffected by that 3h figure.
- Practically: a monitor block asking for `waitSeconds`/`intervalSeconds` near
  the 99,999,999s clamp will run into the 364-day execution timeout long
  before the requested wait elapses. The clamp exists to match the `Wait`
  state's own contract (so `detect-monitor.js` never rejects a value SFN would
  accept), not to promise the full 3.17 years will actually be honored.

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
- `web/amplify/constructs/agentWebhookStack.ts` — the `RouteAgentResult` Choice;
  `InitMonitor` / `RouteMonitorKind`; the condition-poll states (`MonitorWait` /
  `RunMonitorCheck` / `RouteCheck` / `PrepareMonitorReinvoke` /
  `IncrementIteration` / `PostMonitorStoppedComment`); the timed-wait states
  (`TimedMonitorWait` / `PrepareTimedMonitorReinvoke`, #377); and the state
  machine's `timeout:` prop (364 days, #377).
- `web/amplify/functions/agent-webhook-monitor-check/` — the `RunMonitorCheck`
  Lambda (runs `checkCommand` in the runtime session, returns `conditionMet`).
- `web/amplify/backend.ts` — wires the Lambda, its `CLAUDE_CODE_RUNTIME_ARN`
  env, and its `InvokeAgentRuntime` grant (same shape as the invoke-claude
  branch).

See [webhook-stepfunction-integration.md](webhook-stepfunction-integration.md)
for the surrounding webhook → Step Functions pipeline.
