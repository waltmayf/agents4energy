# Training the harness with Claude Code (agents training agents)

This repo ships an autonomous coding agent — the AgentCore webhook harness (see
[agentic-architecture.md](agentic-architecture.md) and
[webhook-stepfunction-integration.md](webhook-stepfunction-integration.md)).
You give it a GitHub issue (by applying the `agentcore` label or `@`-mentioning
it), and it clones the repo, makes a change, verifies it, and opens a PR.

The harness didn't start out able to do that reliably. It was **trained into
competence** by driving it with a stronger agent (Claude Code) in a tight loop:
assign real work → watch it fail → fix the root cause in the repo → redeploy →
assign again. This doc describes that pattern, why it works, and how to run
another turn of it.

The end goal is a ladder: Claude Code makes the harness good enough that the
harness can be trusted with real issues — including issues that *improve the
harness itself*, and eventually issues that stand up and improve **other**
agents. Each rung raises the floor for the next.

## The loop

```
   ┌─────────────────────────────────────────────────────────┐
   │  1. Assign a REAL task to the trainee agent               │
   │     (apply the `agentcore` label to a genuine issue)      │
   │                                                           │
   │  2. Observe the full run, not just the verdict            │
   │     (labels, the final comment, the PR, CI, CloudWatch)   │
   │                                                           │
   │  3. Diagnose the ROOT cause of any failure or low quality │
   │     (not the symptom — the reason the symptom was possible)│
   │                                                           │
   │  4. Fix it in the repo the trainee runs in                │
   │     (system prompt, pipeline, CI gates, tooling, docs)    │
   │                                                           │
   │  5. Redeploy so the fix is live for the trainee           │
   │                                                           │
   │  6. Assign another task → back to 1                       │
   └─────────────────────────────────────────────────────────┘
```

The trainer (Claude Code) has capabilities the trainee lacks yet: it can read
the whole codebase, run deploys, inspect CloudFormation and CloudWatch, file and
cross-link issues, and — crucially — **edit the trainee's own definition**
(system prompt, Step Function, CI). Training is just Claude Code using those
capabilities to close the gaps that each real task exposes.

## Why real tasks, not benchmarks

Every failure in the loop below was found by giving the harness an *actual* issue
from this repo's backlog, not a synthetic test. Real tasks surface real failure
modes in the order they actually bite:

- A transient model error only matters if a real run is long enough to hit it.
- A verification gap only shows up when a task is complex enough to get the code
  subtly wrong.
- A context-overflow only happens on a task whose verification produces huge
  output.

A benchmark you design up front tests the failures you already imagined. Real
tasks test the ones you didn't — which are the ones still costing you.

## The three kinds of fix

When the trainee fails, the fix lands in one of three places, in rough order of
preference:

1. **A hard gate that makes the failure impossible** (best). Example: a
   `pull_request` CI check that blocks merging code that doesn't type-check. The
   trainee can't talk its way past a gate. See
   [e2e-testing.md](e2e-testing.md#pr-checks-gate).
2. **Guidance in the trainee's definition** (good, but soft). Example: the
   harness system prompt telling it to run `npx tsc --noEmit` and never dump huge
   command output. A prompt reduces the failure rate; it can't guarantee zero.
3. **A more robust environment** (foundational). Example: retrying transient
   Bedrock errors in the Step Function, or fixing a deploy so the trainee can run
   at all.

**Prefer a gate over a prompt.** A prompt asks the agent to behave; a gate makes
misbehavior fail loudly and cheaply. When you only have a prompt, assume it will
sometimes be ignored and add a gate behind it when you can.

## A worked example (this repo, milestone #8)

The "Reliable agent harness for programming work" milestone was one long run of
this loop. In order:

| Round | Task assigned | What broke | Root-cause fix | Kind |
|---|---|---|---|---|
| 1 | Publish e2e-config via CDK (#82) | Run died on a transient Bedrock 424 | Retry `InternalServerException`/`RuntimeClientErrorException` in the Step Function (#123) | Environment |
| — | (observed across runs) | Raw model tokens leaked into comments | Strip Harmony tokens before posting (#105) | Environment |
| — | (observed) | One-line system prompt gave no engineering discipline | Rewrote it: investigate → branch → verify → PR (#125) | Guidance |
| 2 | Re-assigned #82 | Deploy itself failed on fresh branches | Gateway authorizer pointed at a dead Cognito pool (#128) | Environment |
| — | (observed) | Harness couldn't run `pnpm` | `pnpm` wasn't on PATH after install | Environment |
| 3 | Re-assigned #82 | Opened a PR that **didn't compile** and claimed success | (a) PR CI gate that blocks non-compiling merges (#135); (b) prompt hardened into a blocking "type-check before PR" gate (#136) | Gate + Guidance |
| 4 | Fix the noisy-lint issue (#139) | Run overflowed the model context (1.16M > 131k tokens) — it ran `pnpm lint` and ingested 59k lines | Prompt rule: never dump large command output; pipe through `tail`/`grep` (#140) | Guidance |
| 5 | Add WELCOME.md (#26) | **Nothing.** It ran `tsc`, reported honestly, opened a clean, minimal PR | — | ✅ |

By round 5 the harness produced a correct, verified, minimal PR on its own — the
behavior we were training toward. Note round 3: the fix wasn't "tell it harder
to verify" — a prompt had already asked and been ignored. The durable fix was a
**gate** (CI) with the prompt as a second layer.

Also note that the trainer's own work went through the trainee's gate: when the
CI gate was activated it was itself broken (missing generated file, wrong Node
version), and the first real PR through it caught that. The gate you build for
the trainee disciplines you too.

## How to run another turn

1. **Pick a real, unblocked issue.** Prefer genuine product/maintenance value
   over contrived tests. Vet it for staleness first — this repo's backlog has
   several already-fixed issues; assigning one teaches you nothing. Check the
   code actually still has the problem.
   - Good early-rung tasks are small and self-contained with *small verification
     output* (a config fix, a self-contained file). Avoid tasks whose
     verification dumps huge output until the overflow guard (#140) is proven.
2. **Trigger the trainee.** Apply the `agentcore` label (or remove + re-add it to
   re-run). The webhook adds `agent-working` and posts a live-session link.
3. **Watch the whole run.** Don't stop at the pass/fail label. Read the final
   comment (did it claim things it didn't do?), open the PR (is the diff minimal
   and correct?), check the CI gate, and read CloudWatch/Step Function output on
   failure.
4. **Diagnose the root cause.** "It failed on a 424" → *why wasn't that retried?*
   "It opened a broken PR" → *why was that possible — no gate? ignored prompt?*
   Fix the reason the symptom could happen, not the symptom.
5. **Fix in the repo, preferring a gate.** File an issue for the root cause
   (cross-link it), make the change, and verify it against the same gate the
   trainee must pass.
6. **Redeploy and confirm the fix is live.** The system prompt is baked into the
   harness at deploy (`agentcore deploy` / the `harnessSpecs` in
   `web/amplify/backend.ts`), *not* runtime-injected — so a prompt change only
   takes effect after a deploy. Confirm the harness resource actually updated
   (CloudFormation `UPDATE_COMPLETE` on `…HarnessMyHarness…`) before re-testing.
7. **Assign again** and check whether the failure class is gone.

## Gotchas learned the hard way

- **The prompt is deployed, not live-edited.** Editing
  `agent/default/app/MyHarness/system-prompt.md` changes nothing until the
  Amplify/AgentCore stack redeploys and the `CfnHarness` resource updates.
  Verify the deploy touched the harness resource, or you'll test the old prompt.
- **`SUCCEEDED` ≠ success.** The webhook Step Function catches failures into a
  post-failure-comment state that itself succeeds, so a caught failure still
  reports the execution as `SUCCEEDED`. Distinguish the real success path
  (`$.agentResult` present, `$.error` absent) from the caught-failure path.
- **The trainee will confidently claim work it didn't do.** It reported "docs
  updated" when they weren't and opened a non-compiling PR calling it done.
  Never trust the final comment — verify the artifact (the diff, the CI result).
- **A gate you add can itself be broken.** Test the gate on a trivial PR before
  trusting it to protect real ones; a false-failing gate is worse than none.
- **Self-referential tasks are a trap for testing.** Assigning the "noisy lint
  output" issue caused a context overflow *because* the task was about noisy
  output. Pick test tasks that don't stress the exact weakness you're unsure of.
- **Clean up test artifacts.** Runs create branches, PRs, and labels. Close and
  delete them so the backlog stays honest.

## The ladder beyond this repo

The same loop scales up a level. Once the harness reliably produces good PRs, it
can be assigned issues that improve *its own* definition (a well-scoped prompt or
pipeline change is just another coding task). And an agent that can reliably
improve one agent can be pointed at standing up and hardening **other** agents —
the trainer role Claude Code played here becomes a role the trainee can play for
the next agent down the line.

The invariant that makes the ladder safe at every rung is the same one from the
worked example: **gates over promises.** An agent training another agent should
leave behind hard checks (CI, verification steps, honest-reporting requirements),
not just better instructions — so each new agent inherits a floor it cannot fall
below, no matter which agent trained it.

## Related

- [agentic-architecture.md](agentic-architecture.md) — how the harness is wired
- [webhook-stepfunction-integration.md](webhook-stepfunction-integration.md) — the trigger → run → comment pipeline
- [e2e-testing.md](e2e-testing.md) — the PR checks gate and the live harness pipeline test
- Milestone: "Reliable agent harness for programming work" (#8) — the worked example above
