# Retrospective: AI-DLC delivery of the `ts#trpc-api → agentcore-harness` connection generator

**What was delivered:** a 6-epic feature in the external `waltmayf/nx-plugin-for-aws` repo (a new nx generator that connects a generated CopilotKit React site to a Bedrock AgentCore Harness), driven end-to-end by the `@agentcore-claude` orchestrator agent that lives in *this* repo (agents4energy).

**Source of truth:** [nx-plugin-for-aws#34](https://github.com/waltmayf/nx-plugin-for-aws/issues/34) (roadmap) and its per-epic issues/PRs.

**Window:** 2026-08-20 15:59 UTC → 2026-08-22 22:51 UTC (~2.5 calendar days). 5 of 6 epics merged to the fork's `main`; the 6th (raise PR upstream) was blocked on GitHub App token scope, not on the work itself.

This doc is a retro on *the delivery process*, so the fixes land in the agentcore-claude machinery here — not on the feature code, which shipped.

---

## Timeline at a glance

| Epic | What | Outcome | Dispatch attempts |
|------|------|---------|-------------------|
| #5 Spike | Validate server-side AG-UI translation vs. a deployed Harness | Merged (PR #35/#37) after ~22h | **~5** |
| #13 Generator MVP | The connection generator, IAM auth | Merged (PR #38) | 1 |
| #21 Frontend + Memory | Point stock `HttpAgent` at `/agui` | Merged (PR #39) | 1 |
| #24 Cognito + docs | JWT-forwarding decision, docs, matrices | Merged (PR #40) | 1 |
| #29 E2E validation | Fresh-workspace deploy + e2e + teardown | Merged (PR #41) | 1 |
| #32 Raise upstream PR | Open PR against `awslabs/nx-plugin-for-aws` | **Blocked** (token has zero perms upstream); mirror PR #42 opened instead | 1 |

The spike (#5) consumed roughly a full day and five dispatch attempts on its own; the four middle epics, once the delivery pattern was dialed in, each went in one clean pass.

---

## What went well

- **The sequential epic pipeline held together.** Each epic re-hydrated its context from the roadmap issue + design doc, dispatched a worker, evaluated, merged, and ticked the checklist. Five epics reached `main` with real code, snapshot/unit/idempotency tests, and PRs.
- **Deploy + e2e caught bugs unit tests never would.** The spike and later epics surfaced concrete, real defects only visible against a live Harness: unsanitized IAM ARNs rejected as `runtimeSessionId`; `sessionIdFor`'s `.slice(0,100)` silently dropping `threadId` for IAM callers (collapsing all conversations into one Memory session); a crash in `actorIdFromEvent` on missing `requestContext` during local `dev`; a `tsc` failure from an unused import under IAM auth. This is the core value of the "deploy every epic" discipline.
- **Steering-doc capture compounded across epics.** The cross-cutting "record deploy fixes in `CLAUDE.md`" instruction worked: later epics inherited the sandbox gotchas earlier ones learned (`uv`/`uvx` not preinstalled, `/mnt/workspace` disk-quota vs. container root for builds, stale `cdk.out` lock from a timed-out `cdk`, a `@nx/js` self-reference Vitest flake, a CDK-CLI credential-provider workaround).
- **The narrow-scope + commit-immediately pattern is what finally made the spike converge.** Once the orchestrator stopped asking one run to do all 7 exit criteria and instead dispatched "do ONE concrete step, commit, push, stop," progress became durable and survived interruptions. Every epic after #5 used this shape and each landed in a single pass.
- **"Accept the worker's test assertion; don't re-verify" removed a whole class of wasted time.** After the owner explicitly said so, the orchestrator stopped re-running full builds itself (which had been slow and had even hit the same `/mnt/workspace` infra failure the worker hit).

---

## What didn't — mapped to the three concerns

### 1. Had to invoke the orchestrator many times (you wanted one invocation → done)

Across the run the owner had to step in **~8 times**: two role-correction nudges early ("you are the orchestrator, not the implementer"), four "please continue" restarts, and two "why are there still 20+ open issues?" questions at the end. Root causes:

- **Role confusion on the first dispatch.** The orchestrator initially started implementing the spike *in its own session* instead of dispatching a worker, so the owner had to correct it twice before the dispatch model took hold.
- **Self-supersession.** Several runs died with *"Cancelled: superseded by a newer agentcore-claude comment on the same issue."* The orchestrator posted process/status comments that themselves contained the literal `@agentcore-claude` mention, which re-fired the webhook and cancelled its own in-flight run. This is the exact hazard recorded in the `agentcore-claude-mention-selftrigger` memory — and it wasted at least three runs (8 min, 32 min, 3h15m all show as "superseded").
- **Monitor-loop stranding.** Repeated *"Monitoring stopped after N checks without the condition being met. Re-invoking…"* entries, and two of the owner's "please continue" nudges were needed because the loop fully stranded the run rather than self-continuing. This is the `monitor-loop-maxiterations-stall` failure (scoped in agents4energy #425) — the done-check never went true, so the loop treated "not done" as "give up."
- **No terminal "the whole roadmap is done" condition.** The orchestrator declared epics complete but left 22 child tracking issues open, so the owner had to ask about them and then explicitly authorize closing them. The definition of done stopped at "epics merged," not "issue tree reconciled."

### 2. The token expired before the agent could use it

Two distinct expiry problems showed up:

- **AWS credential expiry mid-run (the big one).** The first spike implementation run **crashed at 2h22m with `403 The security token included in the request is expired`** — an AWS STS credential TTL expiring during a long deploy step, killing all uncommitted work. Combined with the batch-then-push anti-pattern (one 3h run produced *zero commits after its first 14 minutes*), this is where the most wall-clock was lost.
- **GitHub App token scope (the final blocker).** Epic #32 couldn't open the upstream PR because the GitHub App token had **zero permissions on `awslabs/nx-plugin-for-aws`** — only on the fork. Not an expiry, but a token-scope wall that stopped the last epic cold. (Related to the broader token-lifetime fragility in the `webhook-gh-token-expiry-loses-work` memory.)

The mitigations that already partly worked and should be made policy:
- **Commit + push after every concrete step**, never batch. This single change is what saved the spike.
- **Keep each dispatch short enough to finish inside the credential TTL** — long deploy-heavy runs are exactly where the STS token runs out.
- **Refresh/mint credentials at run start and check remaining TTL before a long deploy**, or hand long-running deploys off to the monitor loop rather than holding them in one session.

### 3. It took longer than expected

The spike alone: ~5 dispatch attempts over ~22 hours. Two full-length runs (3h and ~10h wall) produced nothing durable — one hit the `/mnt/workspace` `Remote I/O error` mount failure at 9h49m, one "produced no text response" after 10h. The deploy-every-epic-then-tear-down loop is inherently expensive, and every long deploy step was a fresh chance to hit the 3h task ceiling (agents4energy #166), a credential expiry, or an infra flake.

**Your proposed remedy — do all the dev work + typecheck first, then deploy/debug once at the end** — is sound and directly addresses the biggest time sink (repeated fragile deploys). Concretely for next time:

- **Phase the pipeline: build-all-then-deploy-once.** Land every epic to green `tsc`/build/unit/snapshot/idempotency first (cheap, fast, no credentials, no 3h risk), then do a *single* consolidated deploy + e2e pass at the end. Deploy is where the credential-TTL, 3h-ceiling, and infra-flake failures cluster, so minimizing the number of deploy cycles minimizes exposure to all three. The trade-off: you lose the per-epic "this specific change deployed cleanly" signal, so keep the deploy smoke-test small and run it once per merged batch rather than per commit.
- **On the git-bisect idea:** worth having in the toolkit, with a caveat. `git bisect run <deploy-smoke-test>` only localizes a failure that is a **deterministic code regression** with a scriptable pass/fail. Most failures in *this* run were **not** code regressions — they were credential expiry, a `/mnt/workspace` mount error, and the 3h ceiling — so bisect would have chased ghosts. Reserve bisect for the case where the end-of-phase deploy fails with an unclear error *and* a prior deploy of an earlier commit is known to have succeeded; otherwise first classify the failure (infra/credential/timeout vs. code) before spending a bisect on it.

---

## Concrete recommendations (for the agentcore-claude machinery in this repo)

1. **Kill self-supersession.** When the orchestrator posts status/process comments, it must obfuscate any `@agentcore-claude` mention (per the `agentcore-claude-mention-selftrigger` memory) so it never cancels its own run. Consider a webhook-side guard: ignore mentions authored by the bot itself. This alone reclaims several dead runs.
2. **Make the orchestrator role unambiguous in the dispatch prompt.** The "you dispatch, you do not implement" instruction had to be repeated twice by a human. Bake a hard, up-front role assertion + a self-check ("am I about to edit code? stop — dispatch instead") into the orchestrator system prompt.
3. **Fix the monitor-loop done-check / max-iterations stall** (agents4energy #425) so the loop distinguishes "condition genuinely not met yet, keep waiting" from "give up," and self-continues instead of stranding — removing the need for "please continue" nudges.
4. **Mandate commit-and-push after every concrete step** in the worker dispatch template, and **scope each dispatch to fit inside the credential TTL and the 3h ceiling** (#166). Never let a worker batch hours of work before its first push.
5. **Adopt build-all-then-deploy-once phasing** for multi-epic roadmaps to cut deploy cycles, per concern #3.
6. **Define "roadmap done" to include reconciling the issue tree** (close child issues referencing their merge PR) so the run terminates cleanly without the owner asking.
7. **Surface token-scope limits before dispatching the epic that needs them.** Epic #32 was dispatched knowing it needed upstream-repo write access the App token never had — check the token's scope against the epic's requirements at dispatch time and flag the gap immediately instead of at the end.

---

## Related agents4energy issues / memory

- `webhook-job-3h-task-timeout` / #166 — 3h hard ceiling loses unpushed work.
- `webhook-gh-token-expiry-loses-work` — token expiry mid-run loses commits.
- `monitor-loop-maxiterations-stall` / #425 — the loop stalls instead of self-continuing.
- `agentcore-claude-mention-selftrigger` — quoting the mention re-fires/cancels the run.
- `dispatched-run-done-signal` — a run is done when `agent-working` clears, not when a PR goes non-draft.
- [docs/autonomous-epic-delivery.md](autonomous-epic-delivery.md) — the operating model this delivery exercised.
