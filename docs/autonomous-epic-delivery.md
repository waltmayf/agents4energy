# Autonomous epic delivery: orchestrator + worker agents

This document describes a way of working where you collaborate with an agent to
turn a feature vision into a tracked backlog, then hand that backlog to a
self-driving loop that implements, reviews, and merges the work — pausing only
when it genuinely needs a human decision.

It is written as a **target operating model**. The last section
([Is this repo set up for it?](#is-this-repo-set-up-for-it)) is an honest
audit of what already exists versus what still has to be built.

---

## The two phases

### Phase 0 — Planning (human + agent, interactive)

You sit down with a local Claude Code session in **plan mode** and describe the
feature set you want. The agent:

1. Explores the codebase and researches options.
2. Proposes **milestones → epics → child issues** with acceptance criteria and
   explicit `blocked-by` dependencies.
3. On your approval, creates the GitHub milestones, issues, native sub-issue
   parent/child links, and a GitHub Project board with an `Actionable` view
   filtered to `no:blocked-by`.

The backlog is the contract. Everything downstream is driven off issues,
labels, and dependency edges — not off this chat.

### Phase 1 — Autonomous delivery (agents, hands-off)

You kick off the loop once. From then on the system drives issues to done
without waiting for you between items, and only stops when **all work is
delivered** or **the only remaining work is blocked on a human decision**.

```
                    ┌─────────────────────────────────────────────┐
                    │            ORCHESTRATOR AGENT                 │
                    │  (a long-lived @agentcore-claude run that     │
                    │   pauses via the Step Functions monitor loop) │
                    └───────────────┬───────────────────────────────┘
                                    │ 1. pick next unblocked epic slice(s)
                                    │ 2. dispatch worker(s)
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  WORKER AGENTS  (one @agentcore-claude run per issue)   │
        │   • branch, implement, push a DRAFT PR early            │
        │   • fix its own CI failures                             │
        │   • document autonomous decisions on the issue/PR       │
        │   • if it needs a human → label `needs-review` + ask    │
        └───────────────────────────────────────────────────────┘
                                    │ workers run for minutes–hours
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  ORCHESTRATOR PAUSES (monitor loop, near-zero compute)  │
        │   • emits a ```monitor``` block: "re-invoke me when no   │
        │     issue carries `agent-working`"                      │
        │   • AgentCore microVM is reclaimed while it waits        │
        │   • Step Functions Wait → check → re-invoke              │
        └───────────────────────────────────────────────────────┘
                                    │ 3. workers done → orchestrator re-invoked
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │  ORCHESTRATOR REVIEWS & MERGES                          │
        │   • green PR → merge (auto-closes its issue)            │
        │   • merge unblocks dependent issues                     │
        │   • empty-handed run (hit ceiling) → re-dispatch smaller │
        │   • needs-review issue → leave it, move on              │
        └───────────────────────────────────────────────────────┘
                                    │ 4. repeat until backlog is drained
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │  STOP: all delivered, or only needs-review    │
                    │  (+ transitively blocked) issues remain       │
                    └─────────────────────────────────────────────┘
```

Orchestrator and worker can be the **same agent binary** (`@agentcore-claude`,
the Claude Code AgentCore Runtime) — they differ only in the prompt they're
dispatched with and the fact that the orchestrator uses the monitor loop to
sleep between waves.

---

## Roles in detail

### The orchestrator

**Responsibilities**

- Read the backlog: work epics in dependency order, finishing an epic's child
  slices before the epic itself; skip anything blocked by an unmerged
  dependency.
- Dispatch each ready slice to a worker (comment `@agentcore-claude <scoped
  instructions>` on the issue). Scope each dispatch **small** — a worker run has
  a hard ~3h ceiling and anything not pushed is lost, so every dispatch must be
  independently pushable and the worker must push a draft PR as soon as its work
  type-checks.
- **Pause** while workers run, holding no compute (see
  [Pausing](#pausing-the-orchestrator-the-monitor-loop)).
- On wake: review each resulting PR, merge the green ones, re-dispatch any run
  that finished empty-handed (it hit the ceiling — slice it smaller), and leave
  `needs-review` issues alone.
- Repeat until the backlog is drained or only human-blocked issues remain, then
  post a final summary and finish.

**Bias to action.** The orchestrator and workers should take reasonable
decisions autonomously and **document them on the issue/PR** rather than
stopping to ask. A human can request changes later. Reserve `needs-review` for
decisions that are genuinely the human's to make (product direction, an
irreversible external action, an ambiguity no default resolves).

### The workers

Each worker is a single `@agentcore-claude` dispatch against one issue. It:

1. Creates a feature branch (never commits to `main`).
2. Implements the change, type-checks (`npx tsc --noEmit`), and — for
   `web/amplify/` changes — runs the credential-free synth gate
   (`cd web && pnpm test:synth`).
3. Pushes a **draft** PR early (so partial work survives if it hits the
   ceiling), with an auto-closing `Closes #<issue>` line in the body.
4. Fixes its own CI failures.
5. Documents any non-obvious choice as an issue/PR comment.
6. If it hits a real decision point, adds `needs-review`, states the options and
   its recommendation in a comment, leaves the PR as a draft, and ends. (The
   runtime already detects an ask-for-input final message and surfaces it — see
   `docs/claude-code-agentcore-runtime.md`.)

### Starting an orchestrator run

The orchestrator has a versioned persona:
[`agent/default/app/ClaudeCode/prompts/orchestrator.md`](../agent/default/app/ClaudeCode/prompts/orchestrator.md).
Orchestrator and worker are the **same** `@agentcore-claude` runtime — they
differ only in which prompt they're told to follow. No code change is needed
to dispatch an orchestrator: the webhook already appends this repo's
`AGENTS.md` to every run's system prompt via `--append-system-prompt`
(`agent/default/app/ClaudeCode/server.js`, `runClaudeCode()`, ~line 465,
fed from `agentsSystemPrompt` in `agent-webhook-invoke-claude/handler.ts`) —
the orchestrator prompt just rides on top of that as a file the agent reads
from its own repo checkout, rather than requiring a second injection path.

To start an orchestrator wave, comment on the **epic issue** you want it to
drive:

```
@agentcore-claude Act as the orchestrator described in
agent/default/app/ClaudeCode/prompts/orchestrator.md — read that file now
and follow it exactly as your operating loop for this epic. Start the first
wave: rebuild the backlog view, dispatch every ready sub-issue, then sleep
per the monitor-loop instructions in that file.
```

That one comment is the entire entrypoint. From there the orchestrator
dispatches workers, sleeps via the monitor loop, wakes, reviews/merges, and
re-dispatches itself with a tiny `followUpPrompt` pointing back at the same
epic and its delivery-ledger comment — see
["Token efficiency"](#token-efficiency-every-wave-starts-cold) below for why
that pointer stays tiny across an unbounded number of waves.

### The human (you)

Between kickoff and completion you do nothing unless an issue is labeled
`needs-review`. That label is the loop's signal back to you. Answer in the issue
comment; remove the label (or reply) and the orchestrator picks it up on its
next wave.

---

## Pausing the orchestrator: the monitor loop

The user-facing requirement — *"the orchestrator says 'pause while the workers
deliver', the AgentCore runtime stops, and the Step Functions wait feature
re-invokes it later"* — is **exactly** the existing monitor loop
(`docs/monitor-loop.md`, epic #260). No fixed 3-hour sleep is needed; the
orchestrator instead sleeps in short polls and is re-invoked the moment its
condition is true.

At the end of a wave the orchestrator emits a fenced ` ```monitor ` block:

````
```monitor
{
  "intervalSeconds": 900,
  "maxIterations": 40,
  "checkCommand": "bash -c \"EXCLUDE_ISSUE=NNN /mnt/workspace/agents4energy/scripts/agents-done-check.sh\"",
  "followUpPrompt": "All dispatched worker runs have finished. Review and merge the green PRs, re-dispatch any issue that finished with no PR, then continue the epic-delivery loop."
}
```
````

`scripts/agents-done-check.sh` (issue #378) is the standard `checkCommand` for
this condition — see below. **`EXCLUDE_ISSUE` must be set to the orchestrator's
own epic issue number** (`NNN` above, issue #395): the Step Functions execution
running the orchestrator holds `agent-working` on that epic issue for the
run's entire duration — including while parked in this very `Wait` — so
without excluding it, the epic issue always matches the label query and the
condition could never return 0. Setting an env var is shell syntax, so this
needs the `bash -c "..."` wrapper (unlike the plain no-args form, which has no
pipes/`&&`/quoting and could be handed to `checkCommand` directly).

What happens then (all already implemented):

- The runtime resumes the paused Step Functions task with
  `agentStatus: 'monitoring'`; the state machine enters a
  `Wait → RunMonitorCheck → Choice` loop.
- **During `Wait` no runtime compute is held** — the AgentCore microVM is
  reclaimed at its idle threshold, so an orchestrator polling every 15 minutes
  for hours costs essentially nothing.
- `RunMonitorCheck` runs `checkCommand` in the **same session** (same
  `/mnt/workspace` clone, same memory). When it exits 0 the orchestrator is
  **re-invoked** with `followUpPrompt`; otherwise the loop waits another
  interval.

**Long waits use the SFN `Wait` state directly.** The Step Functions
[`Wait` state](https://docs.aws.amazon.com/step-functions/latest/dg/state-wait.html)
supports a single wait of **up to 99,999,999 seconds** (~3.17 years) while
holding no compute — so "pause ~3 hours, then continue" is one `Wait`, not a
poll loop. Two orchestrator wait shapes (see issue #377):

- **Timed wait** — a `monitor` block with `waitSeconds` and `followUpPrompt` and
  **no `checkCommand`**: the state machine waits that many seconds via a single
  `Wait(SecondsPath)`, then re-invokes. This is the direct "sleep N seconds"
  the orchestrator wants.
- **Condition poll** — keep `checkCommand` to wake *as soon as* workers are
  done, now with a long `intervalSeconds` so checks are infrequent.

> **Today the monitor loop clamps `intervalSeconds` to `[30, 900]` and requires
> a `checkCommand`** (in `agent/default/app/ClaudeCode/detect-monitor.js`),
> capping a single wait at 15 minutes. Lifting that clamp and making
> `checkCommand` optional (so a bare `Wait` up to the SFN max is honored) is
> **issue #377** — a prerequisite of this operating model, not a workaround.

**Two constraints to design around (documented in `docs/monitor-loop.md`):**

1. **State-machine and task timeouts must not cap a long wait.** The execution
   `timeout` (currently 4h) and the `InvokeClaude` task's 3h `taskTimeout` bound
   the *invoke*, not the `Wait` — issue #377 confirms a long `Wait` between
   invokes isn't killed by either, raising the execution timeout as needed.
2. **`checkCommand` has `git`'s credential store but NOT `gh`'s auth**, and runs
   with no shell. So the orchestrator's "are the workers done?" check must use
   `curl`/`git` (as above), **not** `gh` and **not**
   `scripts/wait-for-agents.sh` (which shells out to `gh`) —
   `scripts/agents-done-check.sh` (issue #378) is the `curl`-only equivalent,
   written for exactly this exec environment. Wrap any pipe/`&&`/quoting in
   `bash -c "..."`.

The "are workers done?" condition is the same one
[`scripts/wait-for-agents.sh`](../scripts/wait-for-agents.sh) uses
interactively: **no *other* open issue carries the `agent-working` label** —
the webhook adds that label when a dispatched run starts and removes it when
the run ends (success *or* empty-handed at the ceiling), so its absence is the
authoritative "my turn to act" signal. The orchestrator's own run is itself one
of these labeled executions (on its epic issue), which is exactly why it must
exclude that one issue from its own check — see `EXCLUDE_ISSUE` above.

---

## Token efficiency: every wave starts cold

A naive orchestrator that keeps one long conversation across every wave would
accumulate an enormous, expensive context window. This architecture avoids that
**by construction** — no trimming logic required.

**Each re-invoke spawns a fresh Claude Code CLI process.** `server.js` runs
`claude -p "<prompt>"` with **no `--resume`/`--continue`**, so a monitor-loop
re-invoke starts with an empty conversation and only the wrapped `followUpPrompt`
([`agentWebhookStack.ts`](../web/amplify/constructs/agentWebhookStack.ts)'s
`PrepareMonitorReinvoke`). What survives a wait is the `/mnt/workspace` git clone
(disk) and AgentCore Memory writes (which feed the *chat UI*, not the next CLI's
context). So an orchestrator's per-wave context is bounded by *that wave's own
work*, never the sum of all prior waves — and the multi-hour `Wait` holds zero
compute **and** zero context.

The design principle that follows: **treat every wave as stateless and
re-derivable from durable external state (GitHub), not from a transcript.**

| Technique | Effect |
|---|---|
| **GitHub is the state store; keep it compact.** The orchestrator reconstructs "where am I?" from the epic checklist, sub-issue rollup, `blocked-by` graph, and a short **delivery-ledger** comment — a few hundred tokens regardless of wave count. | Cross-wave state cost is O(1), not O(waves). |
| **Delegate heavy reading down, not up.** The orchestrator reads *conclusions* (a worker's one-line "merge-ready / blocked because X"), not artifacts. Diffs, CI logs, and file dumps stay in the worker's context. | The biggest per-wave saving — the orchestrator window never fills with PR diffs. |
| **Tiny `followUpPrompt`, lean on prompt caching.** The only thing crossing the wait boundary is a pointer ("resume the loop; read the ledger on epic #NNN"), not a state dump. The stable system prompt is identical each wave → a natural prompt-cache hit. | Cheap cold restarts. |

This also makes the loop **robust**: a wave that crashes loses nothing the next
cold wave can't rebuild from the issue/PR trail.

## Development mode vs. production mode

There must be a **clear, explicit break** between the initial-build period and
production. The break is a single documented signal every run reads at the top
of its turn — a `PROJECT_PHASE: development | production` value (issue #379).
Its default is `development`; flipping it to `production` changes how much the
loop may do without a human.

| | **Development mode** (default) | **Production mode** |
|---|---|---|
| Breaking schema/API changes | Fine — prioritize speed | Require a migration + human review |
| Deleting shared resources (tables, sandboxes, McpServer rows) | Fine | Forbidden without explicit human sign-off |
| **Merge to `main`** | **Orchestrator merges green, on-scope PRs autonomously** | **A human must review and approve every PR before merge — the orchestrator never merges to `main` itself** |
| Autonomy | Full — decide and document | Human approves anything destructive/outward-facing |
| Cedar policy posture | Permissive; iterate freely | Locked down (`docs/tool-governance.md`) |

### The production stage: human-in-the-loop merge

In `development` the loop is fully autonomous end-to-end: workers open PRs and
the orchestrator merges the green, on-scope ones (issue #380) so the epic drains
without human action. In `production` the merge step becomes a **human gate**:

1. Workers still implement and push PRs exactly as before.
2. The orchestrator still reviews, runs the merge bar (green CI, valid
   auto-close keyword, on-scope diff), and does everything *up to* merge.
3. Instead of merging, it marks the PR **ready for human review** — posts its
   merge-readiness verdict as a PR comment, requests review, and labels the
   source issue `needs-review`.
4. **A human reviews the diff and merges to `main`** (or requests changes). The
   orchestrator does **not** hold merge authority for `main` in this phase.
5. On its next wave the orchestrator picks up the now-merged work, sees the
   dependents unblock, and continues — the human merge is just another gate it
   waits on, like a `needs-review` question.

This keeps the throughput of the autonomous loop (planning, implementation,
CI-fixing, review prep all still happen without you) while making the
irreversible, outward-facing action — landing code on `main` — a deliberate
human decision once the project is real. The orchestrator's monitor-loop
done-check in production therefore also treats "PRs awaiting my review" as a
reason to pause and surface, not to keep dispatching new work indefinitely.

> **How the gate is enforced, not just documented.** The cleanest enforcement is
> at two layers: (a) the orchestrator prompt branches on `PROJECT_PHASE` and
> simply never calls `gh pr merge` when `production`; and (b) GitHub **branch
> protection on `main`** (require a PR + at least one human approving review)
> makes an autonomous merge *impossible* even if the prompt-level rule is
> bypassed — belt and suspenders for the one action you most want gated. See
> issues #379 (the flag) and #380 (merge authority scoped by phase).

## Merge policy

The orchestrator's authority to `gh pr merge` (see the "Merge authority" note in
[`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md#git-access-harness-exec-same-session-as-the-agent))
is necessary but not sufficient — it must also apply a consistent **merge bar**
before ever calling it. This section is that bar, written so a cold orchestrator
wave can re-derive it without re-reading this whole document.

### The bar (all four must hold)

1. **All CI checks are green.** Check `gh pr checks <n>` or
   `gh pr view <n> --json statusCheckRollup,mergeStateStatus`. Pending checks are
   not green — wait or re-poll via the monitor loop, don't merge on "probably
   fine." A run with zero configured checks passes vacuously; that's expected
   for docs-only repos and not a reason to block.
2. **The PR body contains a valid, parsing auto-closing keyword** —
   `Closes #<issue>`, `Fixes #<issue>`, or `Resolves #<issue>`, each on its own
   line, referencing an issue in this same repo. **Verify by parsing the actual
   body text, not by assuming the dispatch instructions were followed** — a
   worker can construct its `gh pr create --body "...\n\nCloses #87"` inside a
   double-quoted shell string, where `\n` is never expanded and lands in the PR
   body as the two literal characters `\` `n` instead of a newline (this has
   happened — see the `dispatched-agent-multi-pr-overreach`-adjacent case in
   past runs). Fetch the raw body (`gh pr view <n> --json body --jq .body`) and
   check with a regex that does **not** depend on real line breaks, e.g.
   `grep -iE '(closes?|closed|fixes?|fixed|resolves?|resolved)[[:space:]]*#[0-9]+'`
   — that matches whether the separator is a real newline or a literal `\n`. If
   the keyword is present but malformed (comma-joined `Closes #12, #34`, which
   GitHub only auto-closes the first of; or missing a `#`), treat it as failing
   this check and fix the PR body (`gh pr edit <n> --body ...`) before merging —
   don't merge and hope.
3. **The diff is on-scope for its single issue.** Read the changed-files list
   (`gh pr view <n> --json files,additions,deletions`), not the full patch, to
   keep this cheap. Reject as out-of-scope: a diff touching files unrelated to
   the issue's stated area; a "shallow" PR that only adds a stub/comment/TODO
   without the substantive change the issue asked for; a PR that duplicates
   another already-open PR against the same issue (dedupe by issue number —
   only one PR should close a given issue; close/mark the redundant one).
   When in doubt, read the issue's acceptance criteria and check the diff
   actually satisfies them, not just that it compiles.
4. **Phase gate.** In `development`, 1–3 are sufficient — merge autonomously.
   In `production`, 1–3 must hold *and* a human has approved the PR (branch
   protection enforces this, but also check for it explicitly so the
   orchestrator's own judgment agrees with GitHub's) — see
   [The production stage](#the-production-stage-human-in-the-loop-merge) above
   for what the orchestrator does instead of merging when this isn't satisfied.

### Merge command

Once all four hold: `gh pr merge <n> --squash --delete-branch` (squash keeps
`main` history one-commit-per-issue; delete-branch cleans up the now-merged
worker branch). Merging via the PR that carries the closing keyword is what
auto-closes the issue — don't close the issue manually as a separate step.

### Post-merge: confirm the unblock

After merging, the dependency graph should update on its own (GitHub closes
the issue, which drops it out of any `blocked-by`/`no:blocked-by` filtered
view), but a cold orchestrator wave should not just assume this happened
silently — on the **next** wave, re-query the backlog (the epic checklist /
project board's `no:blocked-by` view) and confirm the issue that was
`blocked-by` the just-merged one is now actionable and gets dispatched. If it
still shows as blocked, the dependency edge or the closing keyword didn't do
what was expected — investigate before dispatching around it.

### Never merge a PR that:

- Has a red, pending, or absent-but-expected CI check.
- Is missing a parsing closing keyword for its issue (see check 2 above).
- Is a shallow duplicate or out-of-scope fragment relative to its issue.
- Is in `production` phase and lacks the required human approval.

Any of these → leave the PR as-is (draft or open, whichever it already is),
comment the specific reason on the PR, and move to the next open item rather
than blocking the whole wave on one PR.

---

## Is this repo set up for it?

**Mostly — the mechanisms all exist; the missing piece is an orchestrator
persona and two small pieces of glue.** Today the "orchestrator" role is played
by *you* running a local Claude Code session that follows the loop in
`CLAUDE.md` and blocks on `scripts/wait-for-agents.sh`. Everything needed to
lift that role into an autonomous cloud agent is already built.

### ✅ Already in place

| Capability | Where |
|---|---|
| Plan → milestones → issues → `blocked-by` → Project board | `docs/development-workflow.md`; native sub-issue linking |
| Worker agent that branches, implements, fixes CI, opens PRs | `@agentcore-claude` runtime — `docs/claude-code-agentcore-runtime.md` |
| Dispatch by commenting `@agentcore-claude` / applying `agentcore` label | webhook → Step Functions — `docs/webhook-stepfunction-integration.md` |
| **Pause with no compute + timed re-invoke** (the "wait feature") | monitor loop — `docs/monitor-loop.md` (Wait → RunMonitorCheck → re-invoke, microVM reclaimed while waiting) |
| Authoritative "workers done" signal | `agent-working` label add/remove; `scripts/wait-for-agents.sh`, `scripts/review-queue.sh` (interactive, `gh`-based), `scripts/agents-done-check.sh` (`curl`-only, for the monitor loop — #378) |
| Human-input escalation | `needs-review` label convention (`CLAUDE.md`) + runtime `awaiting_input` detection (#185) |
| Last-write-wins cancellation of superseded runs | `docs/webhook-stepfunction-integration.md` (issue #182) |
| Small-slice dispatch discipline (3h ceiling, push draft early) | `CLAUDE.md`; memory: `webhook-job-3h-task-timeout` |

### ⚠️ Gaps to close for full autonomy

These are tracked under **epic #376** and its child issues:

1. ✅ **Long-wait support in the monitor loop (#377, closed).** The SFN `Wait`
   state allows a single wait up to 99,999,999 s; `detect-monitor.js` now
   accepts a timed-wait shape (`waitSeconds`, no `checkCommand`) alongside the
   condition-poll shape, so the orchestrator can sleep for hours in one `Wait`.
   See `docs/monitor-loop.md`.

2. ✅ **`gh`-free "workers done" check (#378, closed).** The natural done-check
   (`wait-for-agents.sh`) shells out to `gh`, which isn't authenticated in the
   `RunMonitorCheck` exec environment. Closed by `scripts/agents-done-check.sh`
   — a `curl`/`git`-only equivalent usable verbatim as a `checkCommand` (see
   above).

3. ✅ **`PROJECT_PHASE` dev/prod flag (#379, closed).** The "breaking changes
   are fine during development" rule now has one explicit `PROJECT_PHASE`
   signal (in `CLAUDE.md`/`AGENTS.md`) every run reads before a destructive
   action, gating it in `production`. See
   [Development mode vs. production mode](#development-mode-vs-production-mode)
   below.

4. **Orchestrator merge authority + policy (#380).** ✅ Authority already
   exists — the installation token's `pull_requests: write` permission covers
   `gh pr merge` (see the note in `docs/webhook-stepfunction-integration.md`);
   no code change was needed. Policy is now encoded in
   [Merge policy](#merge-policy) above. What's left is wiring the policy into
   the orchestrator's actual prompt — that's #381.

5. ✅ **Orchestrator agent persona (#381, closed).** A versioned orchestrator
   system prompt now exists —
   [`agent/default/app/ClaudeCode/prompts/orchestrator.md`](../agent/default/app/ClaudeCode/prompts/orchestrator.md)
   — encoding the pick-slice → dispatch → sleep → review/merge → repeat loop,
   the stateless-per-wave design (delivery-ledger comment, tiny
   `followUpPrompt`), and the `PROJECT_PHASE`-gated merge bar. Dispatched the
   same way as a worker (`@agentcore-claude` comment) — see
   [Starting an orchestrator run](#starting-an-orchestrator-run) above. The
   end-to-end dry run proving it live on a throwaway epic is #382.

6. **End-to-end dry run (#382).** Prove the whole loop on a throwaway epic and
   document what was observed.

### Bottom line

The hard infrastructure — a coding agent on AgentCore, a webhook dispatch
pipeline, a compute-free pause/re-invoke loop, and a reliable done-signal — is
**already built and in production use**. What remains is orchestration *policy*,
not new infrastructure: an orchestrator prompt, a `gh`-free done-check for the
monitor loop, merge authority for the orchestrator, and an explicit dev/prod
phase flag. Those are a few days of prompt/glue work on top of a platform that
already does the load-bearing parts.

---

## Related docs

- [`docs/development-workflow.md`](./development-workflow.md) — the plan → implement → review → merge loop (human-driven today)
- [`docs/monitor-loop.md`](./monitor-loop.md) — the pause/re-invoke mechanism the orchestrator uses to sleep between waves
- [`docs/claude-code-agentcore-runtime.md`](./claude-code-agentcore-runtime.md) — the `@agentcore-claude` worker/orchestrator runtime
- [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md) — how a comment dispatches a run
- [`docs/waiting-for-remote-agents.md`](./waiting-for-remote-agents.md) — the `agent-working` done-signal and wait/review scripts
- [`CLAUDE.md`](../CLAUDE.md) — the dispatch/wait/merge conventions the in-repo agent follows
