# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Guidance

### PROJECT_PHASE

`PROJECT_PHASE: development`

This is the single machine-readable signal every agent run reads at the top of its turn before taking any destructive or irreversible action. Default: `development`. It gates breaking schema/API changes and deletion of shared resources (DynamoDB tables, Amplify sandboxes, `McpServer` rows, IAM roles, etc.) — anything another workstream could be relying on and that can't be trivially undone. Non-destructive work (additive schema changes, new files, most feature work) is never gated by this flag.

- **`development`** (current default) — destructive/irreversible actions are allowed without asking. Document what you changed or deleted, and why, directly on the issue/PR — that record is the review trail, not a blocker.
- **`production`** — before taking the action, add the `needs-review` label to the issue and ask the specific question as a comment (state what you want to do and why), then leave any in-progress PR as a **draft** and move to other open work. Do not proceed until the label is cleared. The merge bar also adds mandatory human diff review for any PR containing a destructive action — an orchestrator agent must not merge one on its own while in `production`.

To flip phases, update the `PROJECT_PHASE` line above in both `CLAUDE.md` and `AGENTS.md` (they must agree) and note the change on the tracking issue. See [docs/autonomous-epic-delivery.md](docs/autonomous-epic-delivery.md#development-mode-vs-production-mode) for the full policy and how it fits into the autonomous epic-delivery loop.

### AWS CLI
If you would like to run an aws cli command you don't have access to, put the command in your response and ask the user to run it.

### GitHub Pull Requests
Always type check your changes before pushing updates by running `npx tsc --noEmit`.

If your change touches `web/amplify/` (backend/CDK — Lambdas, `backend.ts`, constructs, data schema, storage), also run `cd web && pnpm test:synth` before pushing. This is the credential-free CDK synth gate (issue #152): it catches CloudFormation errors `tsc` cannot — most importantly **cross-stack dependency cycles** (e.g. a `defineFunction` in Amplify's shared function stack that references data-stack tables via env/IAM/`DynamoEventSource`, which closes a `data → function → data` cycle). `tsc` passing does **not** mean the backend synthesizes; a cycle only surfaces at synth/deploy. When a Lambda must reference resources from another stack, put it in its own `backend.createStack(...)` as a raw `NodejsFunction` rather than a `defineFunction` — see the `SyncCedarPolicies` / `S3ToolsGatewayTarget` / `AgentWebhookStack` constructs for the pattern.

### GitHub Issues

When you start working on an issue, inspect the code base to check if the description and comments in the issue are stale.

**Best practices for PRs:**
- Use the GitHub CLI (`gh pr create`) to open a pull request.
- In the PR body, include a closing reference like `Closes #<issue>` to automatically close the related issue when the PR merges.
- Example PR body:
  ```
  Implement feature X.
  
  Closes #87
  ```

- Reference related issues using `Relates to #<issue>` if appropriate.
- Ensure the PR title is concise and follows the repo convention.
- Add relevant labels via the GitHub UI or automation.

### Web Searching with the Browser Tool

The repository includes a **browser tool** (powered by Playwright) that lets agents programmatically search the internet and extract information.

**Typical workflow**

1. **Start a session** – `init_session` creates a named session (e.g., `searchsession`). The session persists cookies, local storage, and navigation history.
2. **Navigate** – `navigate` loads a URL. Use a search engine (Bing, DuckDuckGo, Google) with a query parameter, e.g. `https://www.bing.com/search?q=latest+AI+advancements+July+2026`.
3. **Wait for content** – For heavily‑JS pages you may need to wait for a selector to appear before extracting data (`wait_for_selector` or a short `sleep`).
4. **Extract data**  
   * `get_html` – returns the full HTML source of the current page. Good for regex‑based parsing.  
   * `get_text` – returns the visible text for a CSS selector (or the whole page if no selector is supplied). Use selectors like `li.b_algo h2` (Bing result titles) or `article h1` on news sites.
5. **Interact if needed** – You can `click`, `type`, or `press` keys to follow links, fill forms, or paginate.
6. **Close the session** – `close_session` releases resources (optional; sessions are cleaned up automatically after a timeout).

**Tips & gotchas**

- Keep the session name at least 10 characters (the tool enforces this).  
- Use specific selectors to avoid pulling navigation menus or ads.  
- If a page is rendered after a network request, add a small delay (`sleep 1`) before extracting.  
- The tool returns raw strings; you may need to post‑process (e.g., split lines, regex) to get clean URLs or titles.  
- Remember that the browser runs headless; some sites may block automated traffic – fallback to a different search engine if you encounter a CAPTCHA.

**Example (pseudo‑code for an agent)**

```text
init_session name=websearch
navigate url=https://www.bing.com/search?q=latest+AI+advancements+July+2026
get_text selector=li.b_algo h2   # titles of the top results
```

The extracted titles can then be summarised or used to build direct links to the articles.

---

### GitHub Issues & Pull Request Best Practices

When working on a feature or bug:

1. **Create an issue** – Write a concise title, a clear description, steps to reproduce (if applicable), and add appropriate labels (e.g., `bug`, `enhancement`, `agentcore`).
2. **Link related work** – Mention other issues with `Related to #<num>` to create bi‑directional links.
3. **Branch naming** – Use `feature/<short‑description>` or `bugfix/<short‑description>`; for this task we used `test/web-browser-harness-70`.
4. **Commit messages** – Start with a verb, reference the issue (`#70`) and keep the body short. Example: `Add browser‑harness test script (#70)`.
5. **Open a PR** – Use the GitHub CLI:

   ```bash
   gh pr create --repo waltmayf/agents4energy \
                --base main \
                --head <branch> \
                --title "Test Web Browser Harness" \
                --body "Adds a simple script to test the web browser harness using Playwright. This script can be run to fetch page titles.\n\nCloses #70"
   ```

   The `Closes #70` line ensures the issue is automatically closed when the PR merges.
6. **PR checklist** – Verify that:
   - Tests pass (`pnpm test:e2e` if applicable).
   - Docs are updated (e.g., `AGENTS.md`).
   - Labels are applied (`agentcore`, `documentation`).
7. **Review & merge** – After approval, squash‑merge to keep a clean history.

Following these conventions keeps the repository tidy and lets GitHub automatically close issues tied to PRs.


When you start working on an issue, inspect the code base to check if they description and comments in the issue are stale.

If you discover a bug:
1. Check the current github issues cover the bug, and if so make sure the issue has sufficient context
2. If not, create a github issue. Use the github native relationships feature to describe blocking relationships with other issues.

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
```

There is no separate AgentCore CLI/deploy step — `pnpm deploy` (`scripts/build.sh` → a single `npx ampx sandbox --once`) builds and deploys the AgentCore harness/memory/gateway/runtimes together with the rest of the Amplify backend, inlined via the `AgentCoreApplication` CDK construct.

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
| `web/amplify/agentcore/` | AgentCore config/sources — typed `agentcore.config.ts` (memories, runtimes, policy engines), the required-but-inert `agentcore.json` sentinel, `MyHarness/system-prompt.md`, and the `ClaudeCode/`/`AguiAgent/` container build contexts |
| `web/amplify/constructs/agentCoreApplication.ts` | `AgentCoreApplication` — the L3 CDK construct `backend.ts` feeds `agentcore.config.ts` into |
| `packages/shared-types/` | Types shared between `web` and other workspaces |
| `scripts/` | Dev utilities: `build.sh`, `invoke.ts`, `create-mcp-server.ts` |

## Architecture

AgentCore and Amplify are no longer separate deployments — a single Amplify backend (`web/amplify/backend.ts`) owns both, deployed together by one `npx ampx sandbox --once`:

**AgentCore resources**: Config lives as typed TypeScript in `web/amplify/agentcore/agentcore.config.ts` (memories, runtimes, policy engines, gateway base specs) and is fed to the `AgentCoreApplication` L3 CDK construct (`web/amplify/constructs/agentCoreApplication.ts`), which `backend.ts` instantiates directly in its own `backend.createStack(...)` (`agentStack`). This provisions a Bedrock AgentCore Harness (`MyHarness`, prompt at `web/amplify/agentcore/MyHarness/system-prompt.md`) backed by `openai.gpt-oss-120b`, persistent memory (`MyHarnessMemory` with SEMANTIC, USER_PREFERENCE, SUMMARIZATION, and EPISODIC strategies), a MCP Gateway that validates Cognito JWTs, the built-in `agentcore_browser` tool, and AgentCore Runtimes (`ClaudeCode`, `AguiAgent`) built via CodeBuild → ECR → CfnRuntime. (The `agentcore_code_interpreter` sandbox was removed — see #191 — so the agent runs shell commands in the harness runtime session.)

**Amplify half** (`web/amplify/backend.ts`): DynamoDB-backed AppSync API (Amplify Gen 2) managing `Agent`, `McpServer`, `ChatSession`, and `ChatMessage` records. Four Lambda functions handle: agent invocation via SigV4, MCP tool discovery, session message restoration from memory, and gateway target registration.

**Request path**: Browser → `HarnessChatTransport` (`web/lib/agentcore-transport.ts`) → `POST /harnesses/invoke` (Cognito JWT auth) → Harness → Bedrock model → binary AWS event stream → `aws-event-stream.ts` decoder → React streaming UI via AI SDK `useChat`.

**Agent config is runtime-injectable**: The selected `Agent` record's `systemPromptText`, `modelId`, and linked `McpServer` URLs are injected into every harness invoke. Changing an agent's config takes effect immediately — no redeployment.

**Deployment wiring**: The AgentCore Memory/Gateway/Runtime ARNs are same-stack CDK tokens read straight off the `AgentCoreApplication` construct and written into `amplify_outputs.json` via `backend.addOutput({ custom: {...} })` — there's no post-deploy extraction script or intermediate `web/deployment-info.json` file; the frontend imports `amplify_outputs.json` directly.

**Monitor loop**: an `@agentcore-claude` webhook run can end its turn with a fenced ```monitor``` block instead of finishing, handing off to a Wait → RunMonitorCheck → re-invoke branch in the webhook Step Function (`web/amplify/constructs/agentWebhookStack.ts`) — the AgentCore microVM is fully reclaimed between checks, so polling an external condition (a deploy, CI, a long job) for hours costs near-zero compute. See [docs/monitor-loop.md](docs/monitor-loop.md).

See [docs/agentic-architecture.md](docs/agentic-architecture.md) for the full data flow diagram.

## Key Constraints

- `web/amplify/agentcore/agentcore.config.ts` is the source of truth for AgentCore resource config (memories, runtimes, policy engines) — do not edit CDK output directly. Renaming a resource destroys and recreates it.
- `web/amplify/agentcore/agentcore.json` is a near-empty, required-but-inert sentinel (`@aws/agentcore-cdk`'s `findConfigRoot()` throws at synth if a directory literally named `agentcore/` doesn't contain a file literally named `agentcore.json` — it only checks existence, never contents). Do not delete it or put real config back into it.
- The AgentCore Memory ARN and Gateway ID are **derived** from the `AgentCoreApplication` construct in `web/amplify/backend.ts` (`agentCoreApp.memoryArn(...)` / `agentCoreApp.gatewayId(...)`) and published to SSM Parameter Store under `/agentcore/<stackName>/…` to avoid cross-stack CloudFormation export cycles — they are **not** hardcoded, so no manual update is needed after an AgentCore redeploy.
- E2E tests run serially (workers=1) because tests share session state stored in `localStorage`.
