# AgentCore provisioning: the `AgentCoreApplication` construct

`web/amplify/backend.ts` provisions all AgentCore resources — memory, the harness, the AgentCore Runtimes (ClaudeCode, AguiAgent), and the MCP gateway — at CDK synth time, in the same Amplify deploy as everything else, so their ARNs are same-stack tokens that flow straight into Lambda env vars and `amplify_outputs.json`. There is no separate `agentcore deploy`/`agentcore status`/`agentcore dev` CLI step; a single `npx ampx sandbox --once` (via `scripts/build.sh`) owns and deploys these resources directly.

Config is typed TypeScript, not a hand-edited `agentcore.json`: `web/amplify/agentcore/agentcore.config.ts` exports `memories`, `runtimes`, `policyEngines`, and `gateways` consts, which `backend.ts` imports and feeds to the construct. The `agentcore.json` file that still lives alongside it is a near-empty, required-but-inert **sentinel** (see [`web/amplify/agentcore/README.md`](../web/amplify/agentcore/README.md)) — `@aws/agentcore-cdk`'s `findConfigRoot()` throws at synth unless a directory literally named `agentcore/` contains a file literally named `agentcore.json`; it only checks that the file *exists* and never reads its contents. Do not delete it, and do not put real config back into it.

## The construct

[`web/amplify/constructs/agentCoreApplication.ts`](../web/amplify/constructs/agentCoreApplication.ts) is a **thin wrapper** over the real `AgentCoreApplication` L3 construct from **`@aws/agentcore-cdk`** plus its companion `AgentCoreMcp`:

| Resource | Created by |
|---|---|
| Memories (`MyHarnessMemory`) | `AgentCoreApplication` (from `agentcore.config.ts` `memories`) |
| Runtimes (`ClaudeCode`, `AguiAgent`) | `AgentCoreApplication` (from `agentcore.config.ts` `runtimes` — CodeBuild → ECR → `CfnRuntime`) |
| Policy engines (`DefaultCedar`) | `AgentCoreApplication` (from `agentcore.config.ts` `policyEngines`) |
| Harness (`MyHarness`) + its execution role | `AgentCoreApplication` (from the inlined `HarnessSpec` literal in `backend.ts`) |
| MCP Gateway | `AgentCoreMcp` (from `agentcore.config.ts` `gateways`, passed to the wrapper as `mcpSpec.agentCoreGateways`) |

The wrapper keeps the accessor API `backend.ts` relies on (`harnessArn(name)`, `memoryArn(name)`, `runtimeArn(name)`, `gatewayArn(name)`, `policyEngineArn(name)`, …), each reading a CDK token off the underlying construct's `harnesses` / `memories` / `environments` / `policyEngines` maps (and `AgentCoreMcp.gateways`).

Harness specs are inlined in `backend.ts` (not `agentcore.config.ts`) as literal `HarnessSpec`s so the system prompt (read from `web/amplify/agentcore/MyHarness/system-prompt.md`) and the Cognito JWT authorizer can be injected at synth, per-deployment. Each is wrapped as a `HarnessDeployment` (`{ spec, harnessDir }`) — a full `spec` is what makes the construct emit the `AWS::BedrockAgentCore::Harness` resource (not just an IAM role).

### `@aws/agentcore-cdk` version requirement

First-class harness creation (the `AWS::BedrockAgentCore::Harness` resource) landed in **`0.1.0-alpha.38`+**; the repo pins **`0.1.0-alpha.46`**. Earlier alpha.36 only built an IAM execution role for a `harnesses[]` entry — which is why this file used to hand-roll a `bedrock_agent_core.CfnHarness`. That custom `CfnHarness` is gone; the real construct owns the harness now.

`HarnessSpec` (the `harness.json` shape) key fields: `model: { provider: 'bedrock'|'open_ai'|'gemini'|'lite_llm', modelId, apiFormat? }` (note `provider`+`modelId`, **not** `bedrockModelConfig.modelId`); `systemPrompt` (always literal text — file-backed prompts live in `system-prompt.md` in `harnessDir`); `tools: [{ type, name, config? }]`; `memory: { mode: 'managed'|'existing'|'disabled', name?/arn? }`; `truncation: { strategy, config? }`. Harness names are `≤40` chars (tighter than memory/runtime's 48).

The package ships `require`-only exports (no ESM condition), so the wrapper loads its value bindings via `createRequire` while importing the types normally.

### The `setSessionProjectRoot` / sentinel-`agentcore.json` mechanism

Both `RealAgentCoreApplication` (for its runtime/harness container builds) and `AgentCoreMcp` call the SDK's `findConfigRoot()`, which walks up from `process.cwd()` looking for a directory literally named `agentcore/` containing a file literally named `agentcore.json` (existence-only check — contents are never read). Under `ampx sandbox` the cwd is `web/`, not `web/amplify/`, so it would never find `web/amplify/agentcore/` on its own. The wrapper calls `setSessionProjectRoot(projectRoot)` — where `projectRoot` is `web/amplify` (`agentcoreProjectRoot` from `agentcore.config.ts`, i.e. the parent of the `agentcore/` sentinel dir) — to point `findConfigRoot()` there explicitly, mirroring what the `agentcore` CLI does after `init`.

Runtime `codeLocation`s in `agentcore.config.ts` are **absolute paths** (built via `resolve(dirname(import.meta.url), ...)`), so container build contexts (`ClaudeCode/`, `AguiAgent/`) are decoupled from wherever the `agentcore.json` sentinel happens to live and unaffected by `setSessionProjectRoot`.

## Physical names and the fixed-name migration gotcha

The construct derives physical names as `${projectName}_${name}`, and `backend.ts` makes `projectName` unique per deployment (`default_web_<branch>`), so concurrent branches/sandboxes don't collide. The **memory**, **harness**, and **memory execution role** all get an AgentCore-generated random suffix on top of that, so a construct-tree change (new logical ID, same base name) replaces them cleanly.

The **harness execution role is the exception**: `AgentCoreHarnessRole` gives it the bare `${projectName}_${name}` name with **no suffix**. So when the construct tree changes (e.g. a migration that alters the CDK construct path to the harness), its logical ID changes while its physical name stays fixed — and CloudFormation's default create-before-delete on the in-place update fails with **"`default_web_<branch>_MyHarness` already exists."**

**One-time fix — two-phase deploy** (only needed when an *existing* stack's harness logical ID changes; fresh stacks are fine):

```bash
# Phase A — drop the harness so CFN deletes the old fixed-name role
cd web && AGENTCORE_SKIP_HARNESS=1 npx ampx sandbox --once --identifier <branch-slug>
# Phase B — recreate it; the name is now free, new logical ID takes it
cd web && npx ampx sandbox --once --identifier <branch-slug>
```

`AGENTCORE_SKIP_HARNESS=1` (read in `backend.ts`) omits the harness from the deployment; the harness ARN then resolves to `''`, and every consumer already tolerates an empty harness ARN (the invoke Lambdas/state-machine grants are guarded on it). After Phase B the flag is never needed again for that stack.

### Empty-ARN landmines when `AGENTCORE_SKIP_HARNESS=1`

An empty harness ARN is tolerated, but three places reject an empty *string* specifically and must guard/substitute:

- **IAM policy `Resource`** — an empty string fails with *"Resource must be in ARN format or `*`"*. Every `bedrock-agentcore:Invoke*` grant that targets the harness ARN is wrapped in `if (AGENTCORE_HARNESS_ARN) { … }` (invoke-agent Lambda, webhook-invoke-agent Lambda, and the state-machine `InvokeHarness` grant).
- **Step Functions `HarnessArn`** — the native `bedrockagentcore:invokeHarness` task schema-validates the ARN *format* at deploy time and rejects `''` with `SCHEMA_VALIDATION_FAILED`. `agentWebhookStack.ts` substitutes a syntactically-valid placeholder ARN (`arn:aws:bedrock-agentcore:<region>:<account>:harness/placeholder-harness-not-deployed`) when `props.harnessArn` is empty; the harness branch is never routed to while the harness is absent, so it's never invoked.

## Deploy-time env vars are injected at synth — a partial `ampx sandbox` wipes them

`backend.ts` reads GitHub/Jira wiring from `process.env` **at synth time** and bakes the values into the webhook Lambdas' `environment`. The CI deploy (`.github/workflows/deploy.yml`) supplies them from repo *Actions variables*; a **local** `ampx sandbox` that doesn't export them re-synthesizes those Lambdas with **empty** env vars, silently breaking the webhook path (the receiver then 500s with *"GITHUB_WEBHOOK_SECRET_ARN not configured"* and post-comment can't mint a token).

When redeploying `main` locally, export all three before `ampx`:

```bash
export GITHUB_APP_ID=<vars.AGENT_GITHUB_APP_ID>
export GITHUB_APP_PRIVATE_KEY_SECRET_ARN=<vars.AGENT_GITHUB_APP_PRIVATE_KEY_SECRET_ARN>
export GITHUB_WEBHOOK_SECRET_ARN=<vars.AGENT_GITHUB_WEBHOOK_SECRET_ARN>
# read the real values with: gh api repos/<owner>/<repo>/actions/variables
```

> Invoke `ampx` **through the package manager** (`pnpm exec ampx …` or `npx ampx …`) — it requires `npm_config_user_agent` to be set and errors with *"npm_config_user_agent environment variable is undefined"* / *"Command 'ampx' not found"* when run as a bare binary or under a flaky `pnpm ampx` shim.
