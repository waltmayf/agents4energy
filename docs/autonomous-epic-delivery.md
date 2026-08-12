# Autonomous epic-delivery loop

Epic #376 describes a self-driving loop: an **orchestrator** agent picks the
next unblocked issue, dispatches a **worker** agent (`@agentcore-claude`) to
implement it, pauses with near-zero compute while the worker runs (via the
[monitor loop](monitor-loop.md)), then reviews the resulting PR, merges it,
and moves to the next item — stopping only when the backlog is drained or the
only remaining issues need a human decision.

The load-bearing infrastructure already exists: the worker runtime, webhook
dispatch, the compute-free pause/re-invoke monitor loop, and the
`agent-working` done-signal (see [docs/waiting-for-remote-agents.md](waiting-for-remote-agents.md)).
This epic closes the remaining **orchestration policy** gaps so the loop can
run hands-off:

| Gap | Issue | Status |
|-----|-------|--------|
| A `gh`-free "workers done" check for the monitor loop (`curl`/`git` only) | #378 | open |
| `PROJECT_PHASE` dev/prod flag gating destructive actions | #379 | this doc |
| Merge authority + merge policy for the orchestrator | #380 | open |
| Orchestrator agent persona (system prompt + dispatch entrypoint) | #381 | open |
| End-to-end dry run of the full loop on a throwaway epic | #382 | open |

## Roles

- **Orchestrator** — the top-level agent a human dispatches once. It reads the
  backlog, dispatches workers, sleeps via a `monitor` block, wakes when
  `agent-working` clears on all issues it dispatched, reviews + merges green
  PRs, re-dispatches empty-handed runs (they hit the turn/time ceiling), and
  repeats. Persona and merge authority are specified in #381 and #380.
- **Worker** — an `@agentcore-claude` webhook run dispatched on a single
  issue (this is what handles most `@agentcore-claude` comments today,
  including the run that wrote this doc). Implements the issue on a branch,
  pushes a draft PR early, keeps it updated, and either finishes or hits the
  ceiling and stops with whatever is pushed.

Both roles read the same `PROJECT_PHASE` signal and apply it the same way —
the gate is symmetric, not orchestrator-only.

## Development mode vs. production mode

`PROJECT_PHASE` (declared in [`CLAUDE.md`](../CLAUDE.md#project_phase) and
[`AGENTS.md`](../AGENTS.md#project_phase), so it is injected into every
run's context) is the single machine-readable signal both roles read before
taking a **destructive or irreversible action** — a breaking schema/API
change, or deleting a shared resource (a DynamoDB table, an Amplify sandbox,
a `McpServer` row, an IAM role, etc.). Non-destructive work — additive schema
changes, new files, most feature work — is never gated by this flag.

| | `development` (default) | `production` |
|---|---|---|
| Breaking schema/API change | Allowed without asking. Document what changed and why on the issue/PR. | Requires the gate below before proceeding. |
| Deleting a shared resource (table, sandbox, `McpServer` row, IAM role, …) | Allowed without asking. Document what was deleted and why. | Requires the gate below before proceeding. |
| Non-destructive work (additive changes, new files, most features) | Never gated. | Never gated. |
| Worker behavior on a destructive action | Proceeds; documents the decision as an issue/PR comment. | Adds the `needs-review` label to the issue, asks the specific question as a comment (what it wants to do and why), leaves any in-progress PR as a **draft**, and moves to other open work until the label is cleared. |
| Merge bar | Normal: green checks + the usual PR review. | Adds mandatory **human diff review** for any PR containing a destructive action — an orchestrator must not self-merge one; it waits for the `needs-review` label to clear (see #380 for the full merge policy). |

The project is currently in **`development`** phase. To move to `production`,
update the `PROJECT_PHASE` line in both `CLAUDE.md` and `AGENTS.md` (they
must agree) and note the change — and its date — on the tracking issue for
the phase switch.

## Why one flag instead of per-action judgment calls

Before this issue, "breaking changes and deleting shared resources are fine
during development, gated in production" existed only as prose the worker had
to infer case-by-case. That's fine for a single human-supervised run, but the
orchestrator loop dispatches many workers without a human in the loop between
dispatches — so the gate needs to be a single value every run can read
mechanically, not a judgment call that could be applied inconsistently
across runs.

## Related docs

- [docs/monitor-loop.md](monitor-loop.md) — the compute-free pause/re-invoke
  mechanism both orchestrator and worker runs use to wait on external
  conditions.
- [docs/waiting-for-remote-agents.md](waiting-for-remote-agents.md) — the
  `agent-working` label protocol and the `wait-for-agents.sh` /
  `review-queue.sh` scripts a human (or, once #378/#380/#381 land, the
  orchestrator) uses to know when dispatched work is done.
