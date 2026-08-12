# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md
@CLAUDE.private.md
## Guidance

### PROJECT_PHASE

`PROJECT_PHASE: development`

This is the single machine-readable signal every agent run reads at the top of its turn before taking any destructive or irreversible action. Default: `development`. It gates breaking schema/API changes and deletion of shared resources (DynamoDB tables, Amplify sandboxes, `McpServer` rows, IAM roles, etc.) — anything another workstream could be relying on and that can't be trivially undone. Non-destructive work (additive schema changes, new files, most feature work) is never gated by this flag.

- **`development`** (current default) — destructive/irreversible actions are allowed without asking. Document what you changed or deleted, and why, directly on the issue/PR — that record is the review trail, not a blocker.
- **`production`** — before taking the action, add the `needs-review` label to the issue and ask the specific question as a comment (state what you want to do and why), then leave any in-progress PR as a **draft** and move to other open work. Do not proceed until the label is cleared. The merge bar also adds mandatory human diff review for any PR containing a destructive action — an orchestrator agent must not merge one on its own while in `production`.

To flip phases, update the `PROJECT_PHASE` line above in both `CLAUDE.md` and `AGENTS.md` (they must agree) and note the change on the tracking issue. See [docs/autonomous-epic-delivery.md](docs/autonomous-epic-delivery.md#development-mode-vs-production-mode) for the full policy and how it fits into the autonomous epic-delivery loop.

### AWS CLI
If you would like to run an aws cli command you don't have access to, put the command in your response and ask the user to run it.

### Querying the AppSync API (GraphQL runner)
Use `./scripts/graphql.sh` to run ad-hoc queries/mutations against the deployed AppSync API. It signs requests with AWS SigV4 (IAM auth) using your local AWS credentials, and reads the endpoint + region from `web/amplify_outputs.json` — so it targets whatever backend that file points at.

```bash
# Query with inline arguments
./scripts/graphql.sh 'query { listChatSessions { items { id name createdAt } } }'

# Query with GraphQL variables (pass a JSON object as the 2nd arg)
./scripts/graphql.sh \
  'query M($s: String!, $a: String!) { listSessionMessages(sessionId: $s, actorId: $a) { events { eventId role text contentJson timestamp } nextToken } }' \
  '{"s":"<session-id>","a":"default"}'
```

Handy for investigating chat sessions: `listSessionMessages` returns the raw stored events (`role`, `text`, `contentJson`, `timestamp`) exactly as the frontend loads them. The `actorId` for harness sessions is always `"default"`. Results are paginated — follow `nextToken` to get older turns. To reproduce how the UI renders a session, feed the events (sorted ascending by `timestamp`) through `web/lib/converse-to-agui.ts`.

### Updating GitHub workflows
The GitHub-hosted Claude Code Action (running as the GitHub App) can't push changes to `.github/workflows/` — in that context, update `.github/workflow-drafts/` instead and ask the user to copy the workflow to the other folder. The local Claude Code CLI does have write access to `.github/workflows/` and may edit and push those files directly (keep the matching draft in sync).

### GitHub Issues

When you start working on an issue, inspect the code base to check if they description and comments in the issue are stale.

If you discover a bug:
1. Check the current github issues cover the bug, and if so make sure the issue has sufficient context
2. If not, create a github issue. Use the github native relationships feature to describe blocking relationships with other issues.

#### Scope epics and issues for token efficiency

The autonomous loop is driven by an **orchestrator** agent that dispatches **worker** runs and sleeps between waves via the Step Functions monitor loop. Each wave (worker *and* orchestrator re-invoke) starts a **cold** Claude Code process — there is no `--resume`, so no conversation context carries across a wait. That's a feature: cost per wave is bounded by that wave's own work, never the sum of all prior waves. Plan issues so this stays cheap:

- **One issue = one independently-deliverable slice.** Size each child issue so a single worker can finish it in one turn (well under the ~3h ceiling) and push a PR — small enough that the worker never needs a huge context to complete it. Prefer more small slices over few large ones.
- **Make every slice re-hydratable from GitHub, not from chat.** The issue body must carry all context a cold agent needs: acceptance criteria, affected paths, links to relevant docs/code, and the design decision. Never assume the agent remembers a prior wave or this conversation — it won't.
- **Keep cross-wave state compact and external.** The orchestrator reconstructs "where am I?" from a compact durable source (the epic's checklist, sub-issue rollup, `blocked-by` graph, and a short delivery-ledger comment) — not from a growing transcript. Decisions, blockers, and progress live on the issue/PR trail so the next cold wave re-reads a few hundred tokens, not a full history.
- **Delegate heavy reading down, not up.** Design the flow so the orchestrator reads *conclusions* (a worker's one-line "merge-ready / blocked because X"), while diffs, CI logs, and file dumps stay in the worker's context and never accumulate in the orchestrator's window.

See [docs/autonomous-epic-delivery.md](docs/autonomous-epic-delivery.md) for the full operating model this scoping supports.

### GitHub Pull Requests

Every PR that resolves an issue **must** include a GitHub auto-closing keyword in its body so the issue closes automatically on merge. Use one of `Closes #<issue>`, `Fixes #<issue>`, or `Resolves #<issue>` (each on its own line). Use `Relates to #<issue>` only for a non-closing reference.

- The closing keyword must be in the PR **body**, not just the title — GitHub only auto-closes from the body/commit messages.
- One keyword per issue: to close several, list them separately (`Closes #12\nCloses #34`); a comma-joined `Closes #12, #34` closes only the first.
- The referenced issue must be in the **same repo** as the PR (`waltmayf/agents4energy`); a cross-repo reference won't auto-close.
- This applies to PRs opened by dispatched agents too — include the closing line in the dispatch instructions, and if a PR arrives without it, add it (`gh pr edit <n> --body ...`) before merging.

### Dispatching @agentcore-claude and waiting for it

When you dispatch work to the `@agentcore-claude` webhook agent (by commenting on an issue), the webhook adds the `agent-working` label to that issue while the run is in flight and **removes it when the run ends** (whether it succeeds or dies empty-handed at the turn/time ceiling). That label — not PR draft state — is the authoritative "is the remote agent done?" signal. Dispatched runs push **draft** PRs early and leave them draft, so never wait on a PR going non-draft.

**Default waiting method — always use this, not a bespoke per-run poll:**

```bash
# Block until NO open issue carries `agent-working` (all remote agents done),
# then print the review queue. Run it in the background and act when it returns.
./scripts/wait-for-agents.sh              # poll every 90s, no timeout
./scripts/wait-for-agents.sh --timeout 10800   # give up after 3h (exit 124)

# Ad-hoc "what needs my attention right now?" (open PRs incl. drafts + checks,
# still-working issues, and dispatched issues that finished with NO PR):
./scripts/review-queue.sh
./scripts/review-queue.sh --exit-code     # exit 10 if anything needs attention
```

**Once no issue has `agent-working`, the remote agents are done and it's your turn to act** — review the resulting PR(s), and re-dispatch any issue that finished with no PR (it hit the ceiling; re-dispatch in smaller, independently-pushable slices). Scope each dispatch small: a run has a hard ~3h ceiling and anything not pushed is lost, so instruct the agent to push a draft PR as soon as its work type-checks.

These scripts are portable across repos: they resolve the target repo from `REPO` → a `.agents-wait.json` config file → the current directory's git `origin` remote → a built-in fallback, so a bare call from inside any clone targets that clone's repo. See [docs/waiting-for-remote-agents.md](docs/waiting-for-remote-agents.md) for the config keys (`repo`, `workLabel`, `bot`, `sentinel`) and how to wire this into a coding workflow.

### Way of working: implement → deploy → test → merge (autonomous epic loop)

The default mode for open work is an autonomous loop that drives issues to done without waiting for me between items:

1. **Pick the next open item.** Work epics in dependency order — finish an epic's child issues (the `x/N` slices) before the epic itself. Skip anything blocked by an unmerged dependency; come back to it once the blocker lands.
2. **Implement** the change on a feature branch (never commit straight to `main`).
3. **Deploy** to the sandbox (`pnpm deploy`) and, for `web/amplify/` changes, first run the credential-free synth gate (`cd web && pnpm test:synth`). Always type-check (`npx tsc --noEmit`) before pushing.
4. **Test** — run the relevant E2E/lint suite and confirm the change actually works against the deployed backend, not just that it compiles.
5. **Merge** once green: open a PR with the auto-closing keyword and wait for checks. **In `development` phase, merge autonomously** once the PR is green and on-scope. **In `production` phase, do NOT merge to `main` yourself** — prepare the PR (green checks, valid closing keyword, on-scope diff), post your merge-readiness verdict, request review, label the issue `needs-review`, and let a human review and merge. Then move to the next item.
6. **Repeat** until all open work is done.

**Which phase are we in?** Read the `PROJECT_PHASE` signal (see [docs/autonomous-epic-delivery.md](docs/autonomous-epic-delivery.md) — "Development mode vs. production mode"). Default is `development`: breaking changes, deleting shared resources, and autonomous merge to `main` are all fine. In `production`: destructive actions require a `needs-review` gate, and **merging to `main` is a human step** — the loop does everything up to merge, then hands off.

**When you need input from me, don't block the whole loop:**
- Add the `needs-review` label to that issue (`gh issue edit <n> --add-label needs-review --repo waltmayf/agents4energy`).
- Post your specific question as an issue comment (state the options and your recommendation).
- Leave any in-progress PR for that issue as a **draft**, and move on to the next open item.
- Revisit `needs-review` issues once I've answered (the label is my signal back to you — I'll remove it or reply).

Keep me informed by using the issue/PR trail as the source of truth: every decision, blocker, and question lives on the relevant issue, not only in this chat. This is also what keeps the loop token-efficient — each wave restarts cold (no conversation carries across a monitor-loop wait), so the issue/PR trail *is* the memory the next wave re-reads. Treat every wave as stateless and re-derivable from GitHub; keep any running state you need in a compact ledger comment, not in context. See the token-efficiency scoping rules under "GitHub Issues" above.

### Docuemntation
Be sure to keep the documentation in the `./docs` folder fresh. After you make a change, make sure the relevant docs are still correct, and create a new doc if it's something either a developer or user would want to know about.

### Environment setup
The sandbox has network/internet access (e.g. `pnpm install`, `npm registry`, AWS API calls all work) — don't assume otherwise. Run `pnpm install` from the repo root before running `pnpm deploy`, `pnpm test:e2e`, or any other command below — fresh checkouts and sandboxes don't have `node_modules` installed. If a command fails, verify with a direct check (e.g. `curl`, `pnpm --version`) before concluding the environment lacks a capability — don't assume a limitation without testing it first.

## Commands

All commands run from the repo root unless noted.

```bash
# Install dependencies (run this first)
pnpm install

# Full build + deploy (Amplify sandbox → AgentCore → Next.js export)
pnpm deploy

# Tear down all infrastructure
pnpm destroy

# Frontend dev server (HTTPS on localhost:3000)
cd web && pnpm dev

# Frontend lint
cd web && pnpm lint

# E2E tests (from web/)
pnpm test:e2e                        # all tests, headless
pnpm test:e2e e2e/chat.spec.ts       # single file
pnpm test:e2e:ui                     # interactive UI mode

# Invoke the deployed agent from the CLI
npx tsx scripts/invoke.ts "Your prompt here"

# AgentCore CLI (from agent/default/)
agentcore deploy     # deploy harness + memory + gateway
agentcore status     # show deployment status
agentcore validate   # validate agentcore.json before deploying
agentcore dev        # run agent locally with hot-reload
```

Trust the cert once on macOS (from `web/`):
```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certificates/rootCA.pem
```

## Monorepo Layout

| Path | What lives here |
|------|----------------|
| `web/` | Next.js 16 frontend (Amplify Gen 2 backend) |
| `web/amplify/` | Amplify backend — auth, data schema, Lambda functions |
| `web/amplify/data/schemas/` | Modular AppSync schemas: `chat`, `agentConfig`, `agentcoreMemory` |
| `web/amplify/functions/` | Lambda handlers: `invoke-agent`, `list-mcp-tools`, `list-session-messages`, `register-mcp-target` |
| `web/app/(with-auth)/` | Authenticated route group — `chat/` and `agents/` pages |
| `web/lib/` | Transport layer: `agentcore-transport.ts`, `aws-event-stream.ts`, `mcp-auth.ts` |
| `web/e2e/` | Playwright tests |
| `agent/default/` | AgentCore project — harness, memory, gateway config |
| `agent/default/agentcore/agentcore.json` | Declarative AgentCore resource definitions (source of truth) |
| `packages/shared-types/` | Types shared between `web` and other workspaces |
| `scripts/` | Dev utilities: `invoke.ts`, `extract-deployment-info.js`, `create-mcp-server.ts` |

## Architecture

The system has two independently deployed halves that share Cognito auth:

**AgentCore half** (`agent/default/agentcore/agentcore.json`): A Bedrock AgentCore Harness (`MyHarness`) backed by `openai.gpt-oss-120b`. Includes persistent memory (`MyHarnessMemory` with SEMANTIC, USER_PREFERENCE, SUMMARIZATION, and EPISODIC strategies), a MCP Gateway (`default-gateway`) that validates Cognito JWTs, and the built-in `agentcore_browser` tool. (The `agentcore_code_interpreter` sandbox was removed — see #191 — so the agent runs shell commands in the harness runtime session.)

**Amplify half** (`web/amplify/backend.ts`): DynamoDB-backed AppSync API (Amplify Gen 2) managing `Agent`, `McpServer`, `ChatSession`, and `ChatMessage` records. Four Lambda functions handle: agent invocation via SigV4, MCP tool discovery, session message restoration from memory, and gateway target registration.

**Request path**: Browser → `HarnessChatTransport` (`web/lib/agentcore-transport.ts`) → `POST /harnesses/invoke` (Cognito JWT auth) → Harness → Bedrock model → binary AWS event stream → `aws-event-stream.ts` decoder → React streaming UI via AI SDK `useChat`.

**Agent config is runtime-injectable**: The selected `Agent` record's `systemPromptText`, `modelId`, and linked `McpServer` URLs are injected into every harness invoke. Changing an agent's config takes effect immediately — no redeployment.

**Deployment wiring**: After `agentcore deploy`, `scripts/extract-deployment-info.js` reads `agent/default/agentcore/.cli/deployed-state.json` and CloudFormation outputs, then writes `web/deployment-info.json` which the frontend imports at build time for ARNs.

**Monitor loop**: an `@agentcore-claude` webhook run can end its turn with a fenced ```monitor``` block instead of finishing, handing off to a Wait → RunMonitorCheck → re-invoke branch in the webhook Step Function (`web/amplify/constructs/agentWebhookStack.ts`) — the AgentCore microVM is fully reclaimed between checks, so polling an external condition (a deploy, CI, a long job) for hours costs near-zero compute. See [docs/monitor-loop.md](docs/monitor-loop.md).

See [docs/agentic-architecture.md](docs/agentic-architecture.md) for the full data flow diagram.

## Key Constraints

- `agentcore.json` is the source of truth for AgentCore resources — do not edit CDK output files directly. Renaming a resource destroys and recreates it.
- `web/deployment-info.json` is populated by the deploy script; do not hand-edit ARNs there.
- The AgentCore Memory ARN and Gateway ID are **derived** from the `AgentCoreApplication` construct in `web/amplify/backend.ts` (`agentCoreApp.memoryArn(...)` / `agentCoreApp.gatewayId(...)`) and published to SSM Parameter Store under `/agentcore/<stackName>/…` to avoid cross-stack CloudFormation export cycles — they are **not** hardcoded, so no manual update is needed after an AgentCore redeploy.
- E2E tests run serially (workers=1) because tests share session state stored in `localStorage`.
