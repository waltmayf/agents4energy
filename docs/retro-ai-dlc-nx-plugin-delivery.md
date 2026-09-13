# Retro: the nx-plugin-for-aws#34 delivery

Source analysis for the round-2 orchestration hardening in
[epic #459](https://github.com/waltmayf/agents4energy/issues/459). The
[nx-plugin-for-aws#34](https://github.com/waltmayf/nx-plugin-for-aws/issues/34)
delivery ran the full autonomous epic-delivery loop end-to-end across a
multi-epic roadmap and surfaced three gaps that together forced roughly
8 operator nudges. This document is the historical record of what went
wrong; the fixes themselves live in
[`docs/autonomous-epic-delivery.md`](./autonomous-epic-delivery.md) and
[`web/amplify/agentcore/ClaudeCode/prompts/orchestrator.md`](../web/amplify/agentcore/ClaudeCode/prompts/orchestrator.md)
— this doc should stay a retro, not grow new operating guidance.

## What went wrong

### 1. Role confusion (dispatch vs. implement)

On the first dispatch the orchestrator started **implementing** the epic
in its own session instead of dispatching a worker. The operator had to
correct it twice ("you are the orchestrator, not the implementation
agent"). The prompt asserted the dispatch-only role, but not unambiguously
enough, and had no explicit self-check before an edit/write tool call to
catch the slide into implementing.

### 2. No terminal "roadmap done" condition; issue tree left unreconciled

After merging every epic in the roadmap, the orchestrator stopped without
reconciling the underlying issue tree — **22 child tracking issues** were
left open, most because the PR that resolved them referenced a parent
epic's issue number instead of their own. The operator had to ask "why are
there still 20+ open issues?" and then explicitly authorize closing them.
The orchestrator's definition of done stopped at "epics merged" instead of
"issue tree reconciled."

### 3. No deploy-phasing guidance (delivery was slow and deploy-fragile)

Every epic deployed, e2e'd, and tore down its own sandbox rather than
sharing one consolidated pass. Deploy is where failures clustered:
credential-TTL expiry (#467, roughly a 1h token lifetime against
multi-hour runs), the 3h worker ceiling (#166), and infra flakes
(`/mnt/workspace` Remote I/O errors). Two long runs — one ~3h, one ~10h —
produced nothing durable, because work wasn't committed and pushed
incrementally.

## What actually worked

The pattern that converged in practice (used in the throwaway spike, #5)
was narrow: **one concrete step, commit, push, stop.** Runs scoped this
way never lost more than a single step to a credential expiry, ceiling
hit, or infra flake — the opposite of the 3h/10h runs above.

## Caveat: `git bisect` on failed runs

Not every failed run is a code regression. `git bisect` only localizes
**deterministic code regressions** — it's the wrong tool for infra
flakes, credential-TTL expiry, or a run that simply hit its time ceiling.
Classify the failure kind first (code bug vs. infra/credential/timeout)
before reaching for `git bisect`; bisecting a non-deterministic failure
burns a bisect run's worth of dispatches without ever converging.

## Related

- Epic [#459](https://github.com/waltmayf/agents4energy/issues/459) — the
  round-2 hardening epic this retro fed.
- Issue [#495](https://github.com/waltmayf/agents4energy/issues/495) —
  the orchestrator-prompt fix for all three gaps above.
- [`docs/autonomous-epic-delivery.md`](./autonomous-epic-delivery.md) —
  the operating model these fixes are encoded into.
