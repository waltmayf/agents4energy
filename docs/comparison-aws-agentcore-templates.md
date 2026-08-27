# How this repo compares to the AWS fullstack-AgentCore templates

_Analysis date: 2026-08-14. Compares this repository against two AWS Labs
offerings: [`awslabs/fullstack-solution-template-for-agentcore`](https://github.com/awslabs/fullstack-solution-template-for-agentcore)
("FAST") and [`awslabs/loom`](https://github.com/awslabs/loom)._

## TL;DR — recommendation

**Pitch this repo as a complementary offering, not a fold-in.** The three
projects sit at different layers of the AgentCore stack and make
load-bearing, hard-to-reverse platform choices that don't reconcile:

- **FAST** is a *starter scaffold* (React/Vite + CDK/Terraform, agent-SDK-agnostic).
- **Loom** is a *management control plane* (React/Vite + FastAPI/RDS/ECS) for
  governing many agents across environments.
- **This repo** is a *webhook-first, autonomous agent that lives inside
  GitHub/Jira* — the agent is one deterministically orchestrated step in a Step
  Functions workflow, triggered by a ticket comment, with the chat UI as an
  optional live view. It also makes different platform bets throughout (Amplify
  Gen 2, Next.js/AI-SDK, a pluggable handler primitive).

Folding this into FAST or Loom would mean throwing away the parts that make it
distinctive (the webhook-first Step Functions pipeline, Amplify Gen 2,
Next.js/AI-SDK, the pluggable handler primitive, the monitor loop). The
higher-leverage move is to **keep this as a
standalone reference application and contribute its genuinely novel patterns
upstream** as documented patterns rather than as a merged codebase (see
[What to contribute upstream](#what-to-contribute-upstream)).

---

## Side-by-side

| Dimension | **This repo (agents4energy fork)** | **FAST** | **Loom** |
|---|---|---|---|
| **What it is** | Webhook-first, autonomous agent that lives in GitHub/Jira; opinionated Amplify app | Starter template / scaffold | Agent management control plane |
| **Primary interface** | **GitHub / Jira comment** (webhook-triggered); chat UI is an *optional live view* | Chat web app | Chat web app + admin console |
| **Frontend** | Next.js 16, AI SDK `useChat`, AG-UI event stream (optional observer) | React + Vite + shadcn/ui + Tailwind | React 18 + Vite + shadcn/ui + Tailwind v4 |
| **Backend / IaC** | **Amplify Gen 2** (AppSync GraphQL + DynamoDB + Lambda) | AWS CDK (Terraform alt) → Amplify Hosting | AWS SAM/CloudFormation, FastAPI, ECS Fargate + ALB + RDS |
| **Database** | DynamoDB (via Amplify data model) | Not prescribed | SQLite (local) → PostgreSQL/RDS (prod) |
| **Auth** | Cognito (shared across both halves); Hosted-UI OAuth2 + PKCE for MCP clients | Cognito (Auth Code + M2M client-credentials) | Cognito + federated IdPs (Entra/Okta/Auth0/OIDC) |
| **Agent runtime** | **Pluggable "handler" primitive** — one agent config runs on any of 3 interchangeable handlers: managed **Harness**, **Claude Code**, or **generic AG-UI** handler (all in AgentCore) | AgentCore Runtime (one model) | AgentCore Runtime (one model) |
| **Agent framework** | Handler-dependent (Converse harness / Claude Code CLI / Strands+AG-UI); runtime-injected config, no redeploy | Strands + LangGraph reference patterns | Strands (default) + Google ADK |
| **AgentCore memory** | SEMANTIC + USER_PREFERENCE + SUMMARIZATION + EPISODIC | Session-persistence integration points | Semantic + summary + preference + episodic |
| **AgentCore Gateway** | MCP gateway w/ CUSTOM_JWT authorizer; dynamic target registration | Lambda tools behind Gateway auth | A2A (agent-to-agent) protocol |
| **Tools** | `agentcore_browser`, in-runtime shell, dynamic remote MCP servers | Code Interpreter, Lambda tools | Code interpreter, browser, MCP |
| **Authorization / governance** | **Cedar per-group/tier MCP tool grants** keyed on `cognito:groups`, DynamoDB-stream policy sync, admin UI, deny-by-default enforcement at gateway | Cedar fine-grained access control | Group-based authz (21 scopes), HITL approval, audit trails |
| **Observability** | CloudWatch logs; issue/PR trail as durable state | Feedback API | OTel/ADOT, cost dashboard, token counting, admin analytics |
| **Orchestration around the agent** | **STANDARD Step Functions workflow** — arbitrary deterministic actions before/after invocation (token mint, context fetch, git-auth, handler routing, monitor-loop, final comment), with retries + `Catch` | None (direct runtime invoke) | None (direct runtime invoke) |
| **Standout capability** | **Webhook-first autonomous operation**: GitHub/Jira comment → Step Functions pipeline → agent → reply on the ticket; powers the autonomous epic-delivery + microVM-reclaiming monitor loop | Fastest path from zero to a deployed agent app | Centralized lifecycle governance for a fleet of agents |
| **Domain** | Energy-industry heritage (reservoir/production/asset workflows) | Domain-agnostic | Domain-agnostic |
| **Deployment model** | `pnpm deploy` (Amplify sandbox → AgentCore → Next export) | CDK/Terraform + Amplify Hosting; Docker-Compose local | 3-phase: local SQLite → hybrid → full ECS/RDS |

---

## Where each one wins

**FAST wins on time-to-first-agent and neutrality.** It deliberately prescribes
as little as possible (no DB, pluggable agent SDK) so a team can drop in their
own logic. If someone's goal is "give me a clean AgentCore fullstack skeleton,"
FAST is the answer — and this repo is *not* trying to be that (it's opinionated
and carries an energy domain + a lot of bespoke machinery).

**Loom wins on multi-agent governance at scale.** It's a control plane: cost
dashboards, OTel instrumentation, approval workflows, registry integration,
21 authz scopes, per-agent LiteLLM virtual keys. If the need is "operate and
govern dozens of agents across teams and environments," Loom is purpose-built
for that and this repo has no equivalent surface.

**This repo wins on three things neither template has:**

1. **A webhook-first, autonomous-first operating model.** The primary interface
   is not a chat window — it's a **GitHub or Jira comment**. This is the single
   most distinguishing feature and the one most aligned with how customers
   already work. See [The webhook-first, autonomous-first operating model](#the-webhook-first-autonomous-first-operating-model)
   below.

2. **A pluggable handler primitive** — one agent config, interchangeable
   managed-Harness / Claude-Code / AG-UI runtimes over shared memory. See
   [The handler primitive](#the-handler-primitive-one-agent-many-runtimes) below.

3. **Amplify-native, config-driven single-app developer experience.** One
   `pnpm deploy`, runtime-injectable agent config (change system prompt / model
   / MCP URLs with *no redeploy*), AppSync GraphQL + DynamoDB instead of
   API-Gateway+RDS boilerplate, and a Next.js/AI-SDK streaming chat UI. For a
   team already living in Amplify Gen 2, this is a much shorter on-ramp than
   either CDK/Terraform (FAST) or SAM/FastAPI/ECS (Loom).

---

## The webhook-first, autonomous-first operating model

Both FAST and Loom assume a **human-in-a-chat-window** as the primary interface:
the user opens the app, types, and watches the agent stream back. This repo
inverts that. The primary trigger is a **comment on a GitHub issue/PR or a Jira
issue** (`@agentcore` / `@agentcore-claude`, or an applied `agentcore` label) —
an API Gateway webhook → Step Functions pipeline
([`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md))
picks it up, runs the agent, and posts progress and the final result back **as
comments on that same issue**. The chat UI still exists, but it becomes an
*optional live view* — the user can drop in to watch a run in progress, not a
place they must sit.

Why this matters, and why neither template offers an equivalent:

- **It meets teams where they already work.** The unit of interaction is the
  ticket, not a bespoke app. Agents participate in the existing GitHub/Jira
  workflow — issues, PRs, comment threads, labels — so adoption doesn't require
  anyone to change tools or leave their tracker. For most customer use cases
  this is the difference between "another dashboard to check" and "it just shows
  up in the workflow we already run."
- **Autonomous-first, human-optional.** Because the trigger and the transcript
  both live on the ticket, a run is fully self-describing without a human
  present. The autonomous epic-delivery loop builds directly on this: each wave
  is a cold, stateless invocation that re-hydrates its context from the
  issue/PR trail, drives work to a PR, and hands off — no chat session to keep
  alive. The chat window is where a human *chooses* to observe; it is never a
  dependency.
- **The Step Function is the real force multiplier.** The agent invocation is
  one state in a **STANDARD Step Functions workflow**, which means arbitrary
  actions can run **before and after** the model — deterministically, with
  retries and `Catch` error branches. Today's pipeline already does this:
  - *Before:* mint a short-lived, repo-scoped GitHub App token; fetch the full
    issue/PR state (title, body, labels, whole comment thread, PR diffstat) and
    prepend it as `<github_context>`; exec `git`/`gh` credential setup inside
    the runtime session; post an initial progress comment with live-view links.
  - *Route:* a `Choice` state picks the handler (harness vs. Claude Code) from
    the mention.
  - *After:* post the final comment, manage `agent-working` / `agent-error`
    labels, or branch into a **Wait → RunMonitorCheck → re-invoke monitor loop**
    (the AgentCore microVM is fully reclaimed between waits, so polling a deploy
    / CI / multi-hour job for hours costs near-zero compute).

  This "arbitrary pre/post orchestration around the agent" is exactly what real
  customer workflows need — approval gates, data fetches, enrichment,
  notifications, downstream side effects — and it's a first-class part of the
  architecture here, not something a chat-window template exposes.
- **Bring-your-own tracker.** GitHub and Jira are both wired in through the same
  receiver (signature/secret verification per source); the pattern generalizes
  to any system that can POST a webhook.

In short: FAST and Loom are **chat-app-shaped**; this repo is
**workflow-integration-shaped**, with the agent as one deterministically
orchestrated step inside an existing ticketing process.

## The handler primitive: one agent, many runtimes

The defining architectural idea in this repo is that the **handler is a
pluggable primitive**, decoupled from the agent. The *agent* — its
runtime-injected config (system prompt, model, linked MCP server URLs) and its
shared AgentCore Memory — is defined once; the *handler* that executes it is a
swappable choice. Three handlers ship today, each registered additively as a
runtime in `agent/default/agentcore/agentcore.json`'s `runtimes[]` and wired the
same way in `web/amplify/backend.ts`:

| Handler | Runtime | What it is | Emits |
|---|---|---|---|
| **Managed AgentCore handler** (`MyHarness`) | AgentCore **Harness** | The managed Bedrock harness the `/chat` page uses (default `openai.gpt-oss-120b`) | Bedrock **Converse** events (translated to AG-UI client-side by `web/lib/converse-to-agui.ts`) |
| **Claude Code on AgentCore** (`ClaudeCode`) | AgentCore Runtime container | The Claude Code CLI hosted headlessly against Bedrock; drives the `@agentcore-claude` GitHub flow | `stream-json`, persisted to Memory as Converse-shaped turns |
| **Generic AG-UI handler on AgentCore** (`AguiAgent`) | AgentCore Runtime container (`protocol: AGUI`) | A Strands agent wrapped with `@ag-ui/aws-strands`, emitting the [AG-UI protocol](https://docs.ag-ui.com/) natively over SSE — no client-side translation | Native **AG-UI** events (for CopilotKit / AG-UI frontends) |

What makes this a *primitive* rather than three separate demos:

- **Shared everything below the handler.** All three write to the **same**
  `MyHarnessMemory` resource, in the **same** Converse-shaped payload, so a
  conversation run through any handler reads back through the identical path
  (`list-session-messages` → `converse-to-agui.ts`). Memory, auth (Cognito),
  and the MCP gateway are handler-independent.
- **Additive, not forked.** Adding a handler is a new `runtimes[]` entry + the
  mirror wiring — it doesn't touch the others (`AguiAgent` was added exactly
  this way in #176, following `ClaudeCode`'s pattern).
- **Different protocols, one product.** Converse, `stream-json`, and native
  AG-UI are three different wire contracts; the handler primitive lets the same
  product expose whichever a given frontend or integration wants.

**This is the sharpest contrast with FAST and Loom.** Both pick *one* execution
model — "run your Strands/LangGraph/ADK agent in AgentCore Runtime" — and vary
the agent *framework* inside that single model. This repo instead treats the
**execution surface itself** as the pluggable axis: the same configured agent
can be served by a managed harness, by a full coding-agent CLI, or by an
AG-UI-native runtime, chosen per use case. That's an abstraction neither
template offers, and it's the thing most worth leading the pitch with.

> Historical note: an earlier AppSync-subscription "AG-UI Handler" (the Python
> `agent/handler/` container, `#33`) was retired when the harness consolidated;
> `AguiAgent` (#176) is the current AG-UI-native handler. See
> [`docs/agui-runtime.md`](./agui-runtime.md),
> [`docs/claude-code-agentcore-runtime.md`](./claude-code-agentcore-runtime.md),
> and [`docs/agentic-architecture.md`](./agentic-architecture.md).

## AI-SDLC capabilities unique to this repo

Neither FAST nor Loom is an AI-SDLC tool: FAST is a scaffold for *building* an
agent app, Loom is a control plane for *governing* a fleet of agents. Neither
has an agent that participates in the software development lifecycle. This repo
does, via four capabilities the others lack:

1. **An agent that ships code from a ticket.** A GitHub/Jira issue, `agentcore`
   label, or `@`-mention is the work order; the agent clones the repo, makes the
   change, verifies it, and opens a PR. The others run an agent that *answers* —
   this one delivers a diff.

2. **An autonomous plan → deliver → merge loop.** An orchestrator turns a vision
   into milestones/epics/child issues with dependency edges, dispatches worker
   runs that implement and review each slice, and drives them to merged PRs —
   each wave a cold, stateless invocation that re-hydrates from the issue/PR
   trail. It includes a pipeline-aware wait: a run can pause on a long CI/deploy
   condition and auto-resume when it goes green, holding no compute while it
   waits.

3. **Release governance for agent-authored changes.** A machine-readable
   dev/prod phase signal gates destructive actions and autonomous merge to
   `main` (production forces a human review gate), and every run authenticates
   with short-lived, repo-scoped GitHub App tokens instead of long-lived PATs —
   least-privilege CI/CD credentials minted per invocation.

4. **Agent-owned CI/CD and self-improvement.** The agent operates its own
   deploy lifecycle — branch-scoped sandbox deploys, a credential-free synth
   gate it must pass, and automatic stack teardown when a PR closes — and a
   stronger agent trains the weaker one into competence, including on issues
   that improve the agent itself.

## Why "incorporate into one of the others" is the wrong default

The blocking mismatches are structural, not cosmetic:

- **IaC substrate.** This repo's backend *is* Amplify Gen 2 — the data model,
  auth, Lambda wiring, and the AgentCore CDK construct all assume it. FAST is
  raw CDK/Terraform; Loom is SAM + FastAPI + RDS. Porting either direction is a
  ground-up backend rewrite, not a merge.
- **Frontend framework.** Next.js 16 + AI SDK `useChat` + AG-UI vs. both
  templates' React/Vite + shadcn. The transport layer (`agentcore-transport.ts`,
  `aws-event-stream.ts`, AG-UI handler) is Next-shaped.
- **Runtime philosophy.** FAST/Loom fix a single execution model (run *your*
  Strands/ADK/LangGraph agent in AgentCore Runtime) and vary the framework
  inside it. This repo makes the **handler itself** the pluggable axis (managed
  Harness / Claude Code / AG-UI-native), all sharing one agent config and one
  memory. That's a different mental model, not a config flag.

Trying to make this a "mode" inside FAST or Loom would dilute all three: FAST
loses its neutrality, Loom loses its control-plane focus, and this repo loses
the Amplify-native cohesion that is its main ergonomic advantage.

---

## What to contribute upstream

Complementary ≠ isolated. The high-value move is to extract the *ideas* (not the
code) and offer them where they fit:

- **To FAST's `patterns/` directory:** the **webhook-first, Step-Functions-
  orchestrated invocation pattern** (ticket comment → pre-actions → agent →
  post-actions, with the monitor loop as one branch) is the highest-value
  contribution — it's SDK- and frontend-agnostic and adds an entirely new
  interaction model alongside FAST's chat sample. Ship the **handler primitive**
  (one config, swappable managed-Harness / Claude-Code / AG-UI runtimes over
  shared memory) and a "Claude Code as the AgentCore runtime" sample alongside it.
- **To Loom (or as a shared doc):** the **Cedar tier-gated MCP tool governance**
  pattern — `cognito:groups` → Cedar deny-by-default at the gateway, authored in
  a UI and synced via a DynamoDB stream. Loom already does group-based authz;
  this is a concrete, gateway-enforced tier/SaaS-plan model it could adopt.
- **As a standalone blog / sample:** the **webhook-first autonomous
  epic-delivery loop** end to end (GitHub/Jira → Step Functions → agent → PR).
  This is the differentiated story and reads best as its own narrative, with
  FAST/Loom cited as the scaffold/control-plane layers it complements.

## Suggested positioning statement

> _agents4energy is a reference application, not a scaffold or a control plane.
> Use **FAST** to bootstrap a new AgentCore chat app; use **Loom** to govern a
> fleet of agents in production; use **agents4energy** when the agent should
> live **inside your existing GitHub/Jira workflow** — triggered by a ticket
> comment, orchestrated as one step in a Step Functions pipeline (arbitrary
> pre/post actions), with chat as an optional live view. Borrow its webhook-first
> orchestration, handler primitive, monitor loop, and Cedar tier-gating patterns
> into whichever of the above you already run._

---

## Caveats on this analysis

- The two upstream summaries were derived from their public READMEs, which may
  lag their code. Re-verify feature claims (esp. Loom's scope counts and FAST's
  Code-Interpreter details) against the current source before quoting them
  externally.
- This repo retains **energy-domain heritage** in its README/branding
  (`Agents4Energy`) even though the working codebase has been rebuilt around the
  AgentCore harness + autonomous loop. Decide whether the public pitch leads
  with the energy domain or with the domain-agnostic platform capability — they
  imply different audiences.
