# Migrating the `@agentcore-claude` coding worker to CodeBuild

**Status:** proposal / research — not yet scoped into issues.
**Audience:** maintainers of the AgentCore worker + webhook stack.

This doc captures the research and a phased delivery plan for moving the
autonomous coding worker (`@agentcore-claude`) off the **AgentCore Runtime**
(`ClaudeCode` container) and onto **AWS CodeBuild**, while leaving the
interactive chat path (`MyHarness`) where it is.

## TL;DR

- The repo runs "Claude Code" as **two different workloads**: an interactive,
  token-streaming **chat agent** (`MyHarness`) and an autonomous, batch
  **coding worker** (`@agentcore-claude`, the `ClaudeCode` AgentCore runtime).
  Only the second is a candidate to move.
- AgentCore Runtime is the right tool for the chat path (low-latency streaming
  HTTP invoke). It is a poor fit for the batch coding worker, and is the source
  of most of the worker's recurring operational pain.
- CodeBuild is a strong fit for the coding worker: large disk, 8 h timeout, no
  idle-reclaim, native IAM role, and clean Step Functions + GitHub integration.
- The browser live-view keeps working **if the worker still publishes session
  events to AppSync/AgentCore Memory via SigV4** — it just moves from
  token-level streaming to message/event-level updates (fine for an unattended
  run).

## Background: the two workloads

| Workload | Today | Nature | Streaming needs |
|----------|-------|--------|-----------------|
| **Chat agent** (`MyHarness`) | Bedrock model behind the AgentCore Harness; `Browser → HarnessChatTransport → POST /harnesses/invoke`. | Interactive, human in the loop. | Token-level. **Keep on AgentCore.** |
| **Coding worker** (`ClaudeCode`) | AgentCore Runtime container, dispatched by the `@agentcore-claude` webhook, drives the `claude` CLI, pushes draft PRs. | Batch, unattended, minutes–hours. | Event-level is fine. **Move to CodeBuild.** |

The browser doesn't care *where* worker events come from — it renders whatever
lands in the session store. The AgentCore runtime already writes AppSync
directly with SigV4 (no Lambda adapter). A CodeBuild worker publishing the same
session events keeps the live-view producers (#17/#15) working; the only change
is granularity: bursts of "posted a message → ran a tool → posted a result"
rather than a token firehose.

## Why CodeBuild for the coding worker

Mapped against the current backlog (verified 2026-09-14):

### Solved cleanly

- **#531 — 1 GB `/mnt/workspace` ENOSPC wedge.** The 1 GB NFS workspace is an
  AgentCore Runtime constraint; a monorepo `pnpm install` fills it in ~25 min
  and the agent then loops silently on failed writes for the rest of a 3 h run.
  CodeBuild build environments have tens of GB of configurable ephemeral disk —
  this failure mode disappears. (The issue's secondary "fail fast on ENOSPC"
  ask is a code fix worth doing regardless.)

### Retires the recurring class (already-closed exemplars)

- **#178** — `/ping` HealthyBusy hack to stop the microVM being reclaimed
  mid-job. CodeBuild has no idle-reclaim; the hack becomes unnecessary.
- **#166** — runs out of turn / work lost. CodeBuild's 8 h timeout vs the
  ~3 h ceiling widens the window ~2.7×.
- **#310 / #324** — a bad runtime image ships green because CI never boots it.
  A CodeBuild run that can't start its container fails loudly on the spot.

### Enabled but not automatic (needs the SFN-wait rework)

- **#544 / epic #459** — the monitor loop terminates before its awaited
  condition. The self-re-invoking loop exists *because* AgentCore reclaims the
  microVM and offers no `--resume`. With a CodeBuild worker, the wait can be a
  **native SFN `Wait` + `Choice`** loop (durable, no iteration ceiling) rather
  than a budget-limited re-invoke loop. CodeBuild *enables* the fix; the
  orchestration logic still has to be rebuilt.

### Not touched by the host swap (do not oversell)

- **#556** — the AguiAgent/ClaudeCode image build already runs in CodeBuild;
  this is a floating-range `npm install` lockfile drift bug. Fix = `npm ci`
  against a committed lockfile, independent of hosting.
- **#529** — `remote_mcp` tool-name collision lives in the `invoke-agent`
  Lambda / harness tool registration.
- **#464** — live-progress peek reads AgentCore Memory events keyed by runId;
  neutral if the worker keeps publishing to memory. The runId/actorId wiring
  gap remains either way.
- **#316** (#287/#289) — mostly not mooted; harness, gateway, and memory still
  use `@aws/agentcore-cdk`. Only the `CfnRuntime` + `ContainerBuildTrigger`
  slice for `ClaudeCode` is shed.
- GitHub-token-lifecycle issues (closed #467 class) — token expiry mid-run is
  orthogonal; CodeBuild does not refresh tokens.

## CodeBuild × GitHub integration facts (verified against AWS docs)

- **CodeBuild-hosted GitHub Actions runners** are real. A workflow job routes to
  CodeBuild with
  `runs-on: codebuild-<ProjectName>-${{ github.run_id }}-${{ github.run_attempt }}`,
  plus optional label overrides (`image:`, `instance-size:`, `fleet:`,
  `buildspec-override:`). Provisioned via the `WORKFLOW_JOB_QUEUED` webhook
  event. **When CodeBuild is the runner, the project buildspec is ignored** —
  the workflow *steps* run instead (unless `buildspec-override:true`).
- **Bedrock auth is cleaner on a CodeBuild runner:** the job inherits the
  CodeBuild **service role**, so `claude-code-action` with `use_bedrock: true`
  needs no OIDC assume-role dance and no long-lived API key.
- **CodeBuild native webhook events** are: `PUSH`, `PULL_REQUEST_CREATED`,
  `PULL_REQUEST_UPDATED`, `PULL_REQUEST_REOPENED`, `PULL_REQUEST_MERGED`,
  `PULL_REQUEST_CLOSED`, `RELEASED`, `PRERELEASED`, `WORKFLOW_JOB_QUEUED`, with
  filter groups (event, branch, base ref, file path, actor, commit message).
  **There is no `issue_comment` event.** The `@agentcore-claude` dispatch is an
  issue-comment mention, so it **cannot** be a native CodeBuild webhook trigger.
  Route it through GitHub Actions (`on: issue_comment`, which does support it)
  → CodeBuild.
- **CodeConnections** (GitHub App connection) governs CodeBuild's own
  checkout + PR build-status reporting. It is distinct from the app-identity
  installation token the worker uses to `git push` a PR as the bot — keep the
  mint-token path for that.

## The `claude-code-action` vs. custom-buildspec decision

Two viable ways to run the worker on CodeBuild. This is the main design choice.

| | **A. `claude-code-action` on a CodeBuild runner** | **B. Custom `claude` invocation in a CodeBuild build** |
|---|---|---|
| Trigger | GitHub Actions `on: issue_comment` → CodeBuild runner | GitHub Actions `on: issue_comment` → `aws codebuild start-build`, or SFN → `StartBuild.sync` |
| PR/issue plumbing | Provided by the Action | Reuse current worker logic |
| AgentCore Memory / live-view publishing (#17/#15) | **Lost** unless re-added via hooks/MCP/steps | Kept (port existing SigV4 publisher) |
| Monitor-loop `monitor` protocol | Not supported; rebuild | Kept / adapt |
| runId + actorId wiring (#464) | Rebuild | Kept |
| Maintenance | Track upstream Action | Own the code |

**Recommendation:** default to **B** (keep the custom worker, relocate it into a
CodeBuild build) so the live-view, monitor loop, and runId wiring survive the
move. Evaluate **A** only if we decide the worker's sole output is PRs and we're
willing to drop in-chat observability of worker runs.

## Target architecture

```
issue comment "@agentcore-claude ..."
        │  (GitHub Actions: on: issue_comment, parse mention)
        ▼
GitHub Actions workflow  ──►  Step Functions (webhook state machine)
        │                          │
        │                          ├─ StartBuild.sync  ──►  CodeBuild coding run
        │                          │        (claude CLI, big disk, 8 h, IAM role,
        │                          │         publishes session events via SigV4)
        │                          │
        └──────────────────────────┴─ Wait + Choice loop (durable monitor,
                                        replaces re-invoke loop for #544)
```

- The **event router** stays in GitHub Actions (issue-comment support), not a
  bespoke API Gateway + HMAC Lambda — simplifying the `agentWebhookStack`
  receiver + `secret()` plumbing (the #239 / local-deploy-wipes-webhook class).
- The **durable wait** stays in Step Functions (a GitHub Actions job can't
  cheaply idle for hours — 6 h ceiling, billed throughout; SFN `Wait` is free).
- The **coding run** is a CodeBuild build (option B), still writing to AppSync/
  AgentCore Memory so the browser live-view is unchanged.

## Delivery plan

Sized as independently-deliverable slices per the repo's scoping rules.
File each as a child issue under a new epic ("Migrate the coding worker to
CodeBuild"), blocked-by wiring as noted.

| Slice | Goal | Depends on | Retires / advances |
|-------|------|-----------|--------------------|
| **0. Spike / go-no-go** | Stand up a throwaway CodeBuild project that runs the existing `ClaudeCode` image, clones a repo, runs `claude` on a trivial task, and pushes a draft PR. Confirm disk, IAM-role Bedrock auth, and git-push-as-app all work. | — | Validates the whole bet; measures cold-start. |
| **1. CodeBuild coding project (CDK)** | Define the CodeBuild project + service role in a `backend.createStack(...)` construct (tokenless, per the cycle rules). Large disk, VPC if needed, Bedrock + AppSync SigV4 + SSM perms. | 0 | Foundation. |
| **2. Port the worker into a build** | Move the `claude`-invocation + SigV4 session-event publisher (#17/#15) + runId wiring from the runtime container into the CodeBuild build entrypoint. Keep publishing to memory. | 1 | #531 (disk), #178/#166 class. |
| **3. Fail-fast + disk headroom** | Explicit `ENOSPC` abort with a status comment; confirm disk sizing on a real monorepo. | 2 | #531 (second half). |
| **4. GitHub Actions event router** | `on: issue_comment` workflow that parses the `@agentcore-claude` mention and kicks the SFN/CodeBuild path. Retire the API Gateway + HMAC receiver where possible. | 2 | #239 / local-deploy-wipes-webhook simplification. |
| **5. Durable SFN monitor loop** | Replace the re-invoke monitor loop with a native `Wait` + `Choice` loop driving `StartBuild.sync`. | 2, 4 | #544 / epic #459. |
| **6. CI on CodeBuild runners** | Move `deploy.yml` / `checks.yml` / e2e jobs onto CodeBuild-hosted runners (native IAM, big disk, Docker). | — (parallel) | #556 environment class; removes OIDC secret juggling. |
| **7. Decommission the `ClaudeCode` runtime** | Remove the `CfnRuntime` + `ContainerBuildTrigger` for `ClaudeCode` from `agentcore.config.ts`; keep harness/gateway/memory. Update docs. | 2–5 green | Advances #316 (partial). |

### Explicitly out of scope

- Moving the interactive chat (`MyHarness`) off AgentCore — token streaming is a
  genuine UX win there; keep it.
- Fixing #529 and #464 as part of this migration — they are host-independent
  (note them, don't bundle them).
- The #556 lockfile fix itself (`npm ci`) — do that independently; slice 6 only
  changes *where* that build runs.

## Open questions

1. **CodeBuild concurrent-build limit** vs. peak `@agentcore-claude` fan-out —
   confirm the account limit covers parallel dispatches, or request an increase.
2. **Cold-start tolerance** — image pull + provision is tens of seconds per run;
   if that's annoying, use a reserved-capacity fleet (standing cost).
3. **Option A vs B** — do we ever want to adopt `claude-code-action`, or is the
   custom worker (B) the permanent choice? Slice 2 assumes B.
4. **Where the app-identity git token is minted** under the new flow (keep the
   existing mint-token Lambda vs. move into the build).

## References

- Current runtime: [docs/claude-code-agentcore-runtime.md](claude-code-agentcore-runtime.md)
- Webhook + SFN: [docs/webhook-stepfunction-integration.md](webhook-stepfunction-integration.md), [docs/monitor-loop.md](monitor-loop.md)
- Live view: [docs/active-run-live-view.md](active-run-live-view.md)
- Epic delivery model: [docs/autonomous-epic-delivery.md](autonomous-epic-delivery.md)
- AWS: CodeBuild-hosted GitHub Actions runners (`action-runner.html`), GitHub webhook events (`github-webhook.html`).
