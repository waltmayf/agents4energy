# Claude Code as an AgentCore Runtime agent (`@agentcore-claude`)

This repo hosts the **Claude Code CLI** as a first-class Bedrock AgentCore Runtime, invokable by commenting **`@agentcore-claude <request>`** on a GitHub issue or PR. It runs alongside the harness agent (`@agentcore` / the `agentcore` label), which is the `openai.gpt-oss-120b` model behind the AgentCore Harness. See [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md) for the shared webhook → Step Function pipeline both agents share; this page covers the Claude Code runtime specifically.

## Why a Runtime container, not `act` / Docker-in-Docker

AgentCore Runtime executes each session in a Firecracker microVM — **no Docker daemon, no privileged mode**. So instead of emulating the `anthropics/claude-code-action` GitHub Action with `act` (which needs Docker-in-Docker), the container runs the Claude Code CLI *directly*, headlessly, against Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`). This is the approach AWS documents in "Hosting Coding Agents on Amazon Bedrock AgentCore," and it gives anyone already on the GitHub Action a clean migration: same Claude Code, same Bedrock model, minus the Actions-runner layer.

## The container

Source: [`agent/default/app/ClaudeCode/`](../agent/default/app/ClaudeCode/).

| File | What it does |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim` (forced `linux/arm64` — the runtime contract requires ARM64), installs `git` + `gh` + the Claude Code CLI, `CMD ["node", "server.js"]`. Runs as `root`; `server.js` sets `IS_SANDBOX=1` so the CLI accepts `--dangerously-skip-permissions` under root (see the `/invocations` note below) |
| `server.js` | Express server implementing the [AgentCore Runtime HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html): `GET /ping` (health) + `POST /invocations` (work), on `0.0.0.0:8080` |
| `package.json` | `express` only — the CLI is a global npm install in the image |

On `POST /invocations` the server:

1. **Sets up the workspace.** If the payload carries `repo` + `githubToken`, it configures `git`/`gh` credentials (git credential store seeded with the short-lived GitHub App token) and clones the repo into the session-storage mount (`/mnt/workspace`, persistent across stop/resume so a follow-up comment reuses the clone). No repo → a throwaway temp dir.
2. **Runs Claude Code headlessly** — `claude -p "<prompt>" --model <bedrock model> --output-format json --permission-mode acceptEdits --dangerously-skip-permissions`, with an `--append-system-prompt` telling it the repo is cloned, `git`/`gh` are authenticated, and to open a PR with `gh` if it makes changes. `CLAUDE_CODE_USE_BEDROCK=1` routes the model through Bedrock using the runtime execution role's credentials.

   > **Root + `--dangerously-skip-permissions`.** The container image runs as `root`, and the CLI otherwise **refuses** `--dangerously-skip-permissions` under root (*"cannot be used with root/sudo privileges for security reasons"*, exit 1) — which manifests as an HTTP 500 from the runtime with that line in CloudWatch. The fix is `IS_SANDBOX=1` in the spawn env (set in `server.js`): AgentCore Runtime already executes each session in an isolated Firecracker microVM, so declaring the sandbox is accurate and lets the headless run proceed as root (keeping the `/mnt/workspace` mount writable). Do **not** drop `--dangerously-skip-permissions` — it's required for non-interactive operation, not a security toggle to remove.
3. **Returns the final text** — parses the CLI's JSON result object and returns `{ result, repo, issueNumber }`.

Payload shape (sent by `agent-webhook-invoke-claude`):

```jsonc
{
  "prompt":       "<user request, @agentcore-claude stripped>",
  "repo":         "owner/name",   // optional; enables clone + PR
  "issueNumber":  123,            // optional; used in the reply
  "githubToken":  "ghs_...",      // optional; short-lived GitHub App token
  "systemAppend": "<AGENTS.md-derived extra system prompt>" // optional
}
```

The Bedrock model is `ANTHROPIC_MODEL` (default `us.anthropic.claude-sonnet-5`), overridable via the runtime's `envVars` in `agentcore.json` — no code change to bump it.

## How it's provisioned

The runtime is declared in [`agent/default/agentcore/agentcore.json`](../agent/default/agentcore/agentcore.json) under `runtimes[]` (`name: "ClaudeCode"`, `build: "Container"`, `codeLocation: "app/ClaudeCode"`, ARM64, `PUBLIC` network, a `/mnt/workspace` session-storage mount). The real **`AgentCoreApplication`** construct from `@aws/agentcore-cdk` builds it: CodeBuild builds the ARM64 image → pushes to ECR → creates the `AWS::BedrockAgentCore::Runtime`. Its ARN flows through `AgentCoreApplication.runtimeArn('ClaudeCode')` in [`web/amplify/backend.ts`](../web/amplify/backend.ts) into the `agent-webhook-invoke-claude` Lambda's `CLAUDE_CODE_RUNTIME_ARN` env var and an SSM parameter (`/agentcore/<stack>/claude_code_runtime_arn`).

> This is the same construct that now creates the harness and memory — see [`docs/agentcore-cdk-construct.md`](./agentcore-cdk-construct.md) for the migration off the custom wrapper (and the `@aws/agentcore-cdk` version bump that made first-class harness creation available).

## Invocation path

`@agentcore-claude` on a GitHub comment → webhook receiver sets `$.agent = "claude"` → after git-auth prep, the Step Function's `RouteAgent` `Choice` sends it to the **`agent-webhook-invoke-claude`** Lambda instead of the native harness task. That Lambda calls `InvokeAgentRuntimeCommand` on the ClaudeCode runtime (SigV4, its own execution role), collects the runtime's JSON reply, and reshapes it into the same `$.agentResult.Output.Message.Content` array the harness task produces — so the shared `PostFinalComment` step posts both agents' replies identically.

> **IAM: grant the runtime *endpoint*, not just the runtime.** `bedrock-agentcore:InvokeAgentRuntime` authorizes against the runtime's endpoint sub-resource (`arn:…:runtime/<id>/runtime-endpoint/DEFAULT`), **not** the bare runtime ARN. A policy that lists only the runtime ARN fails with `AccessDeniedException` (*"no identity-based policy allows the bedrock-agentcore:InvokeAgentRuntime action"* on `…/runtime-endpoint/DEFAULT`). `web/amplify/backend.ts` therefore grants both `AGENTCORE_CLAUDE_CODE_RUNTIME_ARN` **and** `${AGENTCORE_CLAUDE_CODE_RUNTIME_ARN}/runtime-endpoint/*`.
>
> The SDK call must also send `contentType: 'application/json'` — the runtime's `express.json()` only parses bodies with that content type, so a call without it 400s before the handler's first log line (the `invoke-claude` Lambda already sets it).

The runtime has **no optimized Step Functions integration** (it streams an HTTP body, not a Converse result), which is why the claude branch is a Lambda while the harness branch is the native `bedrockagentcore:invokeHarness` task.

## Verifying

Comment `@agentcore-claude <request>` on an issue/PR in a repo whose webhook points at this deployment's `agent_webhook_url` (see the webhook doc's Setup). The initial comment posts a CloudWatch Live Tail link; the final comment carries Claude Code's summary. On branches where the runtime isn't deployed (`CLAUDE_CODE_RUNTIME_ARN` empty), the claude branch fails cleanly at invoke time with a clear error rather than failing synth/deploy.
