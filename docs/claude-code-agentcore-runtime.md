# Claude Code as an AgentCore Runtime agent (`@agentcore-claude`)

This repo hosts the **Claude Code CLI** as a first-class Bedrock AgentCore Runtime, invokable by commenting **`@agentcore-claude <request>`** on a GitHub issue or PR. It runs alongside the harness agent (`@agentcore` / the `agentcore` label), which is the `openai.gpt-oss-120b` model behind the AgentCore Harness.

Two things are worth understanding separately, and this doc covers both:

1. **[How it's provisioned](#how-its-provisioned-agentcoreapplication)** — the runtime is a container built and deployed by the real `AgentCoreApplication` construct from `@aws/agentcore-cdk`, the same construct that creates the harness and memory.
2. **[How a GitHub comment reaches it](#the-invoke-path-github-issue--claude-code)** — the shared webhook → Step Function pipeline routes `@agentcore-claude` mentions to this runtime and posts the reply back.

See [`docs/agentcore-cdk-construct.md`](./agentcore-cdk-construct.md) for the construct migration in general, and [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md) for the webhook pipeline the harness and Claude Code share.

## Why a Runtime container, not `act` / Docker-in-Docker

AgentCore Runtime executes each session in a Firecracker microVM — **no Docker daemon, no privileged mode**. So instead of emulating the `anthropics/claude-code-action` GitHub Action with `act` (which needs Docker-in-Docker), the container runs the Claude Code CLI *directly*, headlessly, against Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`). This is the approach AWS documents in "Hosting Coding Agents on Amazon Bedrock AgentCore," and it gives anyone already on the GitHub Action a clean migration: same Claude Code, same Bedrock model, minus the Actions-runner layer.

## The container

Source: [`agent/default/app/ClaudeCode/`](../agent/default/app/ClaudeCode/).

| File | What it does |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim` (forced `linux/arm64` — the runtime contract requires ARM64), installs `git` + `gh` + the Claude Code CLI, `CMD ["node", "server.js"]`. Runs as `root`; `server.js` sets `IS_SANDBOX=1` so the CLI accepts `--dangerously-skip-permissions` under root (see the [`/invocations` note](#what-the-server-does) below) |
| `server.js` | Express server implementing the [AgentCore Runtime HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html): `GET /ping` (health — reports `HealthyBusy` while a background job runs so the session isn't reclaimed, see the [callback note](#why-the-callback-pattern--and-how-it-works)) + `POST /invocations` (work), on `0.0.0.0:8080` |
| `package.json` | `express` only — the CLI is a global npm install in the image |

### What the server does

On `POST /invocations` ([server.js](../agent/default/app/ClaudeCode/server.js)) the server:

1. **Sets up the workspace.** If the payload carries `repo` + `githubToken`, it configures `git`/`gh` credentials (a git credential store seeded with the short-lived GitHub App token, plus `GH_TOKEN` for the CLI) and clones the repo into the session-storage mount (`/mnt/workspace`, persistent across stop/resume so a follow-up comment reuses the clone). No repo → a throwaway temp dir.
2. **Runs Claude Code headlessly** — `claude -p "<prompt>" --model <bedrock model> --output-format json --permission-mode acceptEdits --dangerously-skip-permissions`, with an `--append-system-prompt` telling it the repo is cloned, `git`/`gh` are authenticated, and to open a PR with `gh` if it makes changes. `CLAUDE_CODE_USE_BEDROCK=1` routes the model through Bedrock using the runtime execution role's credentials.

   > **Root + `--dangerously-skip-permissions`.** The container image runs as `root`, and the CLI otherwise **refuses** `--dangerously-skip-permissions` under root (*"cannot be used with root/sudo privileges for security reasons"*, exit 1) — which manifests as an HTTP 500 from the runtime with that line in CloudWatch. The fix is `IS_SANDBOX=1` in the spawn env (set in `server.js`): AgentCore Runtime already executes each session in an isolated Firecracker microVM, so declaring the sandbox is accurate and lets the headless run proceed as root (keeping the `/mnt/workspace` mount writable). Do **not** drop `--dangerously-skip-permissions` — it's required for non-interactive operation, not a security toggle to remove.
3. **Returns the final text** — parses the CLI's JSON result object (`--output-format json`) and returns `{ result, repo, issueNumber }`. A non-zero CLI exit becomes a 500 with the tail of stderr (tokens redacted).

Payload shape (sent by `agent-webhook-invoke-claude`):

```jsonc
{
  "prompt":       "<user request, @agentcore-claude stripped>",
  "repo":         "owner/name",   // optional; enables clone + PR
  "issueNumber":  123,            // optional; used in the reply
  "githubToken":  "ghs_...",      // optional; short-lived GitHub App token
  "branch":       "main",         // optional; base branch to clone (default: repo default)
  "systemAppend": "<AGENTS.md-derived extra system prompt>" // optional
}
```

The Bedrock model is `ANTHROPIC_MODEL` (default `us.anthropic.claude-sonnet-5`), overridable via the runtime's `envVars` in `agentcore.json` — no code change to bump it.

### The AgentCore Browser tool (issue #183)

Claude Code speaks MCP natively but has no built-in browser tool, so `runManagedJob` gives it one for the duration of each job via [`browser-mcp.js`](../agent/default/app/ClaudeCode/browser-mcp.js):

1. **Start a session.** `new Browser({ region }).startSession({ timeout: 28800 })` (the `bedrock-agentcore` npm SDK) starts an AgentCore Browser session on the AWS-managed default browser (8h timeout — long enough for the multi-hour jobs described above).
2. **Sign a CDP endpoint.** `browser.generateWebSocketUrl()` returns a `wss://` URL plus SigV4 auth headers for the browser's Chrome DevTools Protocol endpoint (same signing the harness's `agentcore_browser` tool call uses under the hood).
3. **Wrap it in an MCP server.** Rather than teaching Claude Code raw CDP, `@playwright/mcp` (a pinned dependency, not `npx`'d at runtime) is pointed at that endpoint via `--cdp-endpoint`/`--cdp-header` — it becomes a thin MCP wrapper over the already-running remote browser instead of launching its own local Chromium.
4. **Load it into the CLI.** The `{ mcpServers: { "agentcore-browser": { command, args } } }` config is written to a `.mcp-agentcore-browser.json` in the job's `workDir` and passed to `claude -p` via `--mcp-config`, so the model gets `browser_navigate`/`browser_click`/`browser_type`/`browser_screenshot`/etc. through the standard MCP tool-call surface.
5. **Tear down.** `runManagedJob`'s `finally` stops the session (`browser.stopSession()`) and deletes the temp MCP config after the job (success or failure) — one browser session per job, not shared across concurrent runs on the same microVM.

If the session fails to start (e.g. a role that predates the browser connection), `runManagedJob` logs and continues **without** `--mcp-config` rather than failing the whole job — a missing browser tool is better than no Claude Code run at all.

This is wired at the infrastructure level in [`agentcore.json`](../agent/default/agentcore/agentcore.json)'s `ClaudeCode` runtime entry:

```jsonc
"connections": [
  { "id": "browser", "to": { "type": "browser" } }
]
```

`@aws/agentcore-cdk`'s connection wiring (the same mechanism `docs/agentcore-cdk-construct.md` describes) turns that into an IAM grant on the runtime's execution role — `bedrock-agentcore:StartBrowserSession`/`StopBrowserSession`/`GetBrowserSession`/`ConnectBrowserAutomationStream`/etc., scoped to the AWS-managed default browser resource (no `arn` means no customer-owned browser, so no discovery env var is injected either — the SDK defaults to the same `aws.browser.v1` identifier). This is the Runtime-side analog of how `MyHarness` declares `{ type: 'agentcore_browser', ... }` in its `tools[]` (see [`agentic-architecture.md`](./agentic-architecture.md)) — same underlying AgentCore Browser service, reached through MCP instead of a harness built-in tool because Claude Code is a Runtime, not a harness.

## How it's provisioned (`AgentCoreApplication`)

The runtime is declared in [`agent/default/agentcore/agentcore.json`](../agent/default/agentcore/agentcore.json) under `runtimes[]`:

```jsonc
{
  "name": "ClaudeCode",
  "build": "Container",
  "codeLocation": "app/ClaudeCode",   // resolved relative to agent/default/
  "dockerfile": "Dockerfile",
  "entrypoint": "server.js",
  "protocol": "HTTP",
  "networkMode": "PUBLIC",
  "filesystemConfigurations": [
    { "sessionStorage": { "mountPath": "/mnt/workspace" } }
  ],
  "envVars": [{ "name": "ANTHROPIC_MODEL", "value": "us.anthropic.claude-sonnet-5" }]
}
```

The real **`AgentCoreApplication`** L3 construct from `@aws/agentcore-cdk` — the same one that now creates the harness and memory — turns that entry into infrastructure. `backend.ts` passes `projectSpec.runtimes` straight into the construct via the thin wrapper ([`web/amplify/constructs/agentCoreApplication.ts`](../web/amplify/constructs/agentCoreApplication.ts)):

```
agentcore.json runtimes[] ─▶ AgentCoreApplication (props.runtimes)
                               │  for each runtime:
                               │    CodeBuild builds the ARM64 image (codeLocation + Dockerfile)
                               │    └▶ pushes to ECR
                               │        └▶ creates AWS::BedrockAgentCore::Runtime (CfnRuntime)
                               ▼
                            app.environments.get("ClaudeCode").runtime.runtimeArn
```

Because the construct runs at CDK **synth** time inside the Amplify stack, the runtime's ARN is a same-stack token — no post-deploy control-plane lookup. `backend.ts` reads it via the wrapper's `runtimeArn('ClaudeCode')` accessor and threads it into two places ([backend.ts](../web/amplify/backend.ts) ~line 327):

- The `agent-webhook-invoke-claude` Lambda's **`CLAUDE_CODE_RUNTIME_ARN`** env var.
- An **SSM parameter** `/agentcore/<stackName>/claude_code_runtime_arn` (for out-of-band tooling; cross-stack exports are stripped — see the export note in `backend.ts`).

Physical names follow the construct's `${projectName}_${name}` scheme (with `projectName` made unique per deployment), so the runtime is `default_web_<branch>_ClaudeCode` and concurrent branches/sandboxes don't collide. Runtimes are optional: if `agentcore.json` has no `ClaudeCode` runtime, `AGENTCORE_CLAUDE_CODE_RUNTIME_ARN` resolves to `''` and every consumer tolerates the empty ARN (the invoke Lambda throws a clean *"runtime not deployed on this branch"* at call time rather than failing synth).

> The `agentcore_code_interpreter` sandbox tool was removed (#191); Claude Code runs shell commands directly in the container. The container is a Runtime, **not** a harness — the CMD (`node server.js`) is honored as-is.

## The invoke path (GitHub issue → Claude Code)

`@agentcore-claude` shares the webhook → Step Function pipeline with the harness; only the agent-selection branch differs.

```
GitHub issue/PR comment "@agentcore-claude <req>"
   │  (webhook delivery, HMAC-signed)
   ▼
API Gateway HTTP API  ── REQUEST authorizer (signature-format gate, #83)
   ▼
agent-webhook-receiver Lambda
   │  • verify X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET_ARN
   │  • parseMention() → agent = "claude"  (matched BEFORE bare @agentcore)
   │  • skip bot senders (loop prevention)
   │  • StartExecution on the state machine, input.agent = "claude"
   ▼
Step Function  (agentWebhookStack.ts)
   │
   ├─ 1. PostInitialComment ─ posts the CloudWatch Live Tail link, mints a
   │       short-lived GitHub App token, fetches AGENTS.md system prompt
   │
   ├─ 2. PrepareGitAuth ───── returns the annotated prompt (git-auth prep)
   │
   ├─ 3. RouteAgent (Choice on $.agent):
   │       $.agent == "claude"  ─▶ InvokeClaude (Lambda)      ◀── this path
   │       otherwise            ─▶ InvokeHarness (native task)
   │
   │      InvokeClaude = agent-webhook-invoke-claude Lambda
   │        • InvokeAgentRuntimeCommand on CLAUDE_CODE_RUNTIME_ARN, passing a
   │          Step Functions TASK TOKEN (SigV4, its own exec role;
   │          contentType application/json; runtimeSessionId = runId)
   │        • the task PAUSES on the token (up to 3h) — see the callback note
   │
   │      ┌─ runtime runs Claude Code in the background (may take >1h) ─┐
   │      └▶ on finish, runtime calls SendTaskSuccess (or SendTaskFailure)
   │         with $.agentResult.Output.Message.Content[0].Text, resuming ─┐
   │                                                                      │
   └─ 4. PostFinalComment ◀───────────────────────────────────────────────┘
          posts the reply as a GitHub comment
          (both agent branches converge here — identical $.agentResult shape)
```

### Receiver: routing the mention

[`agent-webhook-receiver/handler.ts`](../web/amplify/functions/agent-webhook-receiver/handler.ts) verifies the HMAC signature, then calls `parseMention()` ([`_shared/webhookVerify.ts`](../web/amplify/functions/_shared/webhookVerify.ts)). Because `/@agentcore\b/` **also** matches `@agentcore-claude` (the word boundary sits between `agentcore` and `-`), the claude pattern is tested **first**; a match sets `agent: 'claude'` in the Step Function input. Everything else — a bare `@agentcore`, the `agentcore` label, or any Jira comment (no git context) — routes to `'harness'`.

### Step Function: the claude branch

[`agentWebhookStack.ts`](../web/amplify/constructs/agentWebhookStack.ts) defines a `RouteAgent` `Choice` after git-auth prep:

```
RouteAgent
  .when($.agent == "claude", InvokeClaude)   // Lambda
  .otherwise(InvokeHarness)                    // native bedrockagentcore:invokeHarness task
```

The harness uses the **native** optimized Step Functions integration (it decodes the streamed Converse result). The Claude Code runtime has **no** optimized integration — it streams an HTTP body, not a Converse result — so its branch is a Lambda (`InvokeClaude`). Both branches produce the identical `$.agentResult.Output.Message.Content` array, so the shared `PostFinalComment` step reads them the same way, and both route failures to the same `PostFailureComment` catch.

### Why the callback pattern — and how it works

A synchronous `LambdaInvoke` bounded the whole run at Lambda's **15-minute** hard ceiling: `InvokeClaude` blocked on the runtime's HTTP reply, so a Claude Code job that ran longer timed out into `PostFailureComment` and stamped `agent-error`. Real jobs on this repo routinely run **over an hour** (issue #175), so the `InvokeClaude` branch uses the Step Functions **callback pattern** (`integrationPattern: WAIT_FOR_TASK_TOKEN`), which can keep an execution paused for up to **1 year**:

1. The task passes `sfn.JsonPath.taskToken` in the Lambda payload and **pauses** — its 3-hour `taskTimeout` (the state machine timeout is raised to 4 h so the task-level timeout, not the execution timeout, surfaces to `Catch`) is the new upper bound, matching AgentCore's multi-hour session limit.
2. The `InvokeClaude` Lambda forwards that token to the runtime, waits only for a **quick "job accepted" ack**, and returns. Its function timeout drops from 840 s to 60 s — it no longer awaits the job.
3. The runtime ([`server.js`](../agent/default/app/ClaudeCode/server.js)) sees the `taskToken`, immediately replies `200 { started: true }`, and runs Claude Code **in the background**. When the job finishes it calls `SendTaskSuccess` (output reshaped into the `$.agentResult.Output.Message.Content` shape) — or `SendTaskFailure` on a non-zero CLI exit — **resuming the paused task itself**.

So Step Functions does **not** poll, and the Lambda does not block for the job's duration: the runtime pushes the result back over the task token when it's done. Without a `taskToken` the runtime keeps its old synchronous behavior (used by the direct-invoke smoke test).

> **The background job stays alive because `/ping` reports `HealthyBusy` — this is load-bearing.** After `res.json({ started: true })` returns, the detached `spawn('claude', …)` keeps running in the long-lived Express process, but there's no in-flight HTTP request. AgentCore Runtime polls `GET /ping` to decide when a session is idle and may be snapshotted/suspended/reclaimed: `Healthy` = safe to reclaim, `HealthyBusy` = keep alive. So `server.js` tracks `activeJobs` (incremented before the ack, decremented in a `.finally()` after `SendTask*` resolves) and returns `status: activeJobs > 0 ? 'HealthyBusy' : 'Healthy'`. **Without this, the runtime reclaims the microVM at its idle threshold (~13 min) and kills the job mid-run** — the symptom is a flood of `Write failed: waiting to be backed up.` / `RMDIR failed` in the runtime log group (the session-storage snapshot racing the live process), then silence and no `SendTask*` (bug #178). If a job neither succeeds nor fails within the 3-hour `taskTimeout`, `Catch` treats it as `States.Timeout` → `PostFailureComment`.

### InvokeClaude Lambda → runtime

[`agent-webhook-invoke-claude/handler.ts`](../web/amplify/functions/agent-webhook-invoke-claude/handler.ts) sends `InvokeAgentRuntimeCommand` to `CLAUDE_CODE_RUNTIME_ARN` with:

- `taskToken` — the Step Functions callback token the runtime uses to resume the paused task.
- `runtimeSessionId: runId` — the same session id as the rest of the run, so a follow-up `@agentcore-claude` on the same issue reuses the runtime's `/mnt/workspace` clone.
- `contentType: 'application/json'` and `accept: 'application/json'`.
- the payload described [above](#what-the-server-does).

It confirms the runtime's `{ started: true }` ack (throwing on a ≥400 ack so the task fails before any token hand-off) and returns; the task result is delivered later via the token, not this Lambda's return value.

> **Three gotchas this path depends on** (all fixed in the code):
>
> 1. **IAM — grant the runtime *endpoint*, not just the runtime.** `bedrock-agentcore:InvokeAgentRuntime` authorizes against the runtime's endpoint sub-resource (`arn:…:runtime/<id>/runtime-endpoint/DEFAULT`), **not** the bare runtime ARN. A policy listing only the runtime ARN fails with `AccessDeniedException` (*"no identity-based policy allows the bedrock-agentcore:InvokeAgentRuntime action"* on `…/runtime-endpoint/DEFAULT`). [`backend.ts`](../web/amplify/backend.ts) therefore grants the invoke Lambda's role **both** `AGENTCORE_CLAUDE_CODE_RUNTIME_ARN` **and** `${AGENTCORE_CLAUDE_CODE_RUNTIME_ARN}/runtime-endpoint/*`.
> 2. **`contentType: 'application/json'`.** The runtime's `express.json()` only parses bodies with that content type, so a call without it 400s *before* the handler's first log line.
> 3. **The RUNTIME's execution role — not the state-machine role — needs `states:SendTaskSuccess`/`SendTaskFailure`** on the state machine ARN, because the runtime (not the state machine) resumes the paused task. [`backend.ts`](../web/amplify/backend.ts) grants this via `agentCoreApp.addRuntimeRolePolicy('ClaudeCode', …)`.
>
> The Lambda invokes the runtime with its own execution-role creds (the runtime authorizes with `AWS_IAM`), so the state-machine role needs no runtime grant — it only invokes the Lambda.

## Verifying

Comment `@agentcore-claude <request>` on an issue/PR in a repo whose webhook points at this deployment's `agent_webhook_url` (see the [webhook doc's Setup](./webhook-stepfunction-integration.md)). The initial comment posts a CloudWatch Live Tail link; the final comment carries Claude Code's summary (and a PR link if it made changes). On branches where the runtime isn't deployed (`CLAUDE_CODE_RUNTIME_ARN` empty), the claude branch fails cleanly at invoke time with a clear error rather than failing synth/deploy.

A minimal smoke test that exercises only the container (bypassing GitHub) is to `InvokeAgentRuntime` directly with `{ "prompt": "who and where are you?" }` and `contentType: 'application/json'` — the reply should describe Claude Code running inside an AgentCore Runtime with cwd under `/mnt/workspace`.
