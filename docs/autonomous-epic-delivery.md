# Autonomous epic delivery

The **implement → deploy → test → merge** loop (defined in `CLAUDE.md` /
`AGENTS.md` under "Way of working") lets an orchestrator drive an epic's child
issues to done without a human in the loop between items. Two building blocks
make the loop possible without holding runtime compute the whole time:

1. **Dispatch + wait for remote workers** — the orchestrator comments
   `@agentcore-claude` on child issues to dispatch work, then blocks on
   [`scripts/wait-for-agents.sh`](../scripts/wait-for-agents.sh) (see
   [waiting-for-remote-agents.md](waiting-for-remote-agents.md)) until every
   dispatched issue's `agent-working` label clears.
2. **Monitor handoff** — when the orchestrator itself is an `@agentcore-claude`
   run (e.g. one that just dispatched a batch of workers and now needs to pause
   before checking in), it hands off to the webhook state machine's
   [monitor loop](monitor-loop.md) instead of busy-waiting in-session, so the
   AgentCore microVM is reclaimed while it waits.

## Why the monitor loop needed a timed-wait shape (#377)

Before #377, a monitor handoff only supported a **condition poll**: wait
`intervalSeconds` (clamped to 900s max), run `checkCommand`, repeat up to
`maxIterations` (max 40) times. That's the right shape for "wake as soon as
this becomes true" (CI goes green, a deploy finishes) — but the epic-delivery
loop's "give dispatched workers a few hours, then check the review queue" case
doesn't have a cheap `checkCommand` to poll: `wait-for-agents.sh` *is* the
check, and it isn't meant to run from inside a `RunMonitorCheck` Lambda exec.

The **timed wait** shape covers this directly: no `checkCommand`, just
`{ "waitSeconds": 10800, "followUpPrompt": "..." }` — a single
`Wait(waitSeconds)` (up to the Step Functions `Wait` state's own 99,999,999s
max) followed by an unconditional re-invoke. See
[monitor-loop.md](monitor-loop.md#how-a-run-hands-off-to-a-monitor) for the
full schema and [monitor-loop.md's execution-timeout
section](monitor-loop.md#execution-timeout--the-real-ceiling-on-a-long-wait-377)
for the practical ceiling (the state machine's own 364-day execution
`timeout`, itself just under Step Functions' hard 1-year Standard Workflow
limit).

## Putting it together: an orchestrator run that dispatches and waits

An epic-delivery orchestrator run can now end its turn with:

````
```monitor
{
  "waitSeconds": 10800,
  "followUpPrompt": "Run ./scripts/review-queue.sh, review any open PRs from the batch dispatched this turn, and re-dispatch anything that finished with no PR."
}
```
````

instead of calling `wait-for-agents.sh` and holding runtime compute for the
whole 3h window. The re-invoke lands in the same session (same
`/mnt/workspace`, same memory), so it can pick up exactly where the dispatch
left off.

## When to still block in-session

`wait-for-agents.sh` (blocking, in-session) is still the right tool when the
orchestrator needs the review queue back **this turn** — e.g. it's about to
make a decision that depends on the dispatched runs' outcomes and there's
nothing else useful to do in the meantime. Reach for the monitor's timed wait
when the orchestrator would otherwise sit idle holding compute for a long,
open-ended window with no more decisions to make until it checks back in.
