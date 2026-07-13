# Webhook + Step Function Integration

An API Gateway → Step Function pipeline that lets GitHub *and* Jira comments trigger the agent, replies with a live-progress comment, and posts the final response — without an ephemeral GitHub Actions runner. This is Step 4 of the harness-retirement plan (issue #28); see issue #35 for the original scope.

This **runs alongside** [`docs/github-integration.md`](./github-integration.md)'s Actions-based `@agent-<slug>` mention flow, not in place of it. See "Why alongside, not instead" below.

## How it works

```
GitHub issue_comment webhook          Jira comment_created webhook
  (X-Hub-Signature-256 HMAC)            (?source=jira&secret=<shared secret>)
    │                                      │
    └──────────────┬───────────────────────┘
                    ▼
      API Gateway HTTP API  POST /webhook
                    │
                    ▼
      agent-webhook-receiver Lambda
        • verifies the signature/secret (per source)
        • detects EITHER: the "@webhook-agent" comment mention (issue_comment),
          OR the "agentcore" label applied to an issue/PR (issues/pull_request)
        • loop prevention: ignores Bot / *[bot] senders (GitHub)
        • StartExecution (fire-and-forget — returns 202 immediately,
          well under GitHub's/Jira's webhook timeout)
                    │
                    ▼
      Step Function (STANDARD workflow)
        1. agent-webhook-post-comment (stage=initial)
             • creates this run's CloudWatch Logs stream
             • posts a comment with a Live Tail deep-link
             • GitHub only: mints a GitHub App installation token
             • label-triggered runs only: adds the "agent-working" label
        2. agent-webhook-invoke-agent  (git-auth prep — Lambda)
             • GitHub only: execs a git credential-store setup in the harness's
               runtime session (InvokeAgentRuntimeCommand → POST
               /runtimes/{harnessArn}/commands, SigV4) before the agent runs —
               see "Git access" below
             • writes the exec stdout/stderr + exit code to the run's log stream
               (and this Lambda's own log group) for debugging
             • returns the <github_access>-annotated prompt as
               $.prepared.effectivePrompt
             • on failure: Catch → agent-webhook-post-comment (stage=final,
               isError=true) posts the error AND (label runs) adds "agent-error"
        3. InvokeHarness  (NATIVE bedrockagentcore:invokeHarness task)
             • the optimized Step Functions integration invokes the harness and
               decodes the streamed response into a Converse-shaped result; the
               whole $.agentResult.Output.Message.Content array is passed to
               PostFinalComment, which joins its text blocks (Content can be []
               when the turn ends on a tool action)
             • signed with the STATE MACHINE role (not a Lambda) — no code
             • on failure: Catch → agent-webhook-post-comment (stage=final,
               isError=true)
        4. agent-webhook-post-comment (stage=final)
             • posts the agent's response as a follow-up comment
             • label-triggered runs only: removes "agent-working" (and, on the
               failure path, adds "agent-error")
```

## Label triggers (issue #56)

Alongside the `@webhook-agent` comment mention, applying the **`agentcore`** label to a GitHub issue or PR starts the same pipeline. The receiver handles GitHub `issues` and `pull_request` webhook events with `action == "labeled"` and `label.name == "agentcore"`; the prompt is built from the issue/PR title and body. Label-applied-by-bot events are ignored (same loop-prevention as comments).

The receiver stamps each execution's input with `trigger: "label" | "comment"`. Only `label` runs get the label bookkeeping the issue asked for:

| Step | Label action |
|---|---|
| initial comment posted | add **`agent-working`** |
| final comment posted (success) | remove **`agent-working`** |
| final comment posted (failure Catch, `isError=true`) | remove **`agent-working`**, add **`agent-error`** |

All label calls are best-effort — a label API hiccup logs a warning but never fails the execution. They reuse the same GitHub App installation token minted for posting the comment (no extra mint). `agent-working`/`agent-error` must already exist as repo labels (GitHub auto-creates them on first apply if the App has `issues: write`).

**Why label add/remove stays inside `agent-webhook-post-comment` and not separate Step Function states:** the GitHub label API needs a GitHub **App** installation token (RS256 JWT → installation token), which only the Lambda mints. Adding native `states:` HTTP tasks would each have to re-mint a token; folding the label calls into the comment-posting stage (which already holds a fresh token) is one fewer round-trip and one fewer failure surface.

### Native harness invoke, Lambda-backed git-auth (issue #56)

The harness invoke is the **native `arn:aws:states:::bedrockagentcore:invokeHarness`** optimized integration ([SFN docs](https://docs.aws.amazon.com/step-functions/latest/dg/connect-bedrockagentcore.html)). It decodes the harness's streamed response into a Converse-shaped result. `PostFinalComment` receives the whole `$.agentResult.Output.Message.Content` array and joins its text blocks — **not** a direct `Content[0].Text` JSONPath, which crashes the state when the array is empty. The array **can** be empty (`StopReason=end_turn`, `Content=[]`): the integration omits tool-use and reasoning blocks, so a turn that ends on a tool action has no text block (observed on a web-browsing run, issue #70). When empty, the Lambda posts a friendly "no text response" note instead. No hand-rolled event-stream decoding, and no `agent-webhook-invoke-agent` Lambda in the invoke path. Notes:

- **Request-Response only** — `.sync` / task-token patterns aren't supported (fine here; we want the reply inline).
- **Only the final assistant message** is returned; earlier turns, tool-use, and reasoning blocks are dropped. That's exactly what we post back to the issue.
- **15-minute hard cap** on the task regardless of `TimeoutSeconds`; the state machine's own timeout is also 15 min.
- **Output size** is bounded by the Task state output quota (256 KB) — long agent replies are truncated by that limit, not by us.
- The task is signed with the **state machine's execution role** (granted `bedrock-agentcore:InvokeHarness` + `InvokeAgentRuntime` on the harness ARN in `agentWebhookStack.ts`), not a Lambda role.

**Git-auth stays a Lambda** (`agent-webhook-invoke-agent`, step 2). It runs the pre-invoke git credential-store setup via `InvokeAgentRuntimeCommand` (the harness *exec* API), which:
- has **no optimized Step Functions integration** (only `InvokeHarness` does), and returns an **event stream** whose exit code must be read — a generic `states:` AWS-SDK task can't consume that; and
- produces **stdout/stderr we want captured in CloudWatch** for debugging a failed clone/push — the Lambda writes both to the run's log stream and its own log group.

It shares the run's `runId` as the harness `RuntimeSessionId`, so the credentials it seeds land in the same container the native invoke then uses. It no longer calls `InvokeHarness` (that grant moved to the state machine role).

> **ChatSession is intentionally NOT created by this pipeline.** A `ChatSession` is created browser-side only, when the user opens the chat page. If the page is opened with a session id that doesn't exist yet, the browser creates it and starts listening for AgentCore-memory messages on it. Keeping session creation out of the Step Function avoids orphan sessions for runs nobody watches.

## Why alongside, not instead

The Actions-based flow (`.github/workflows/agent-mention.yml`) already has a correctly-scoped, auto-expiring `GITHUB_TOKEN` for free and works well for GitHub. This webhook path exists because:

1. **Jira has no Actions-runner equivalent** — there's no CI system already wired to Jira comments, so a webhook receiver is the only option there.
2. **A live CloudWatch Logs Live Tail link** is a materially different "watch it work" UX than the AppSync `/chat-handler` live-chat link the Actions flow posts, and this issue asked for it specifically.

To avoid both paths firing on the same GitHub comment, they use **distinct trigger phrases**: Actions matches `@agent[-<slug>]`, this pipeline matches `@webhook-agent`. Retiring the Actions flow in favor of this one — once Jira parity isn't the only reason for it to exist — is a follow-up decision, not made here.

## Signature verification

| Source | Mechanism | Header / param |
|---|---|---|
| GitHub | HMAC-SHA256 over the raw body, keyed by the webhook secret | `X-Hub-Signature-256: sha256=<hex>` |
| Jira | Shared secret, constant-time compared | `?source=jira&secret=<secret>` query param |

**Why Jira uses a shared secret instead of HMAC:** Jira Cloud's classic REST-API-registered webhooks (the kind you register via `POST /rest/webhooks/1.0/webhook` or a simple app descriptor) have no signing scheme equivalent to GitHub's `X-Hub-Signature-256`. Atlassian only signs webhook deliveries for full Connect/Forge app installations, which is a much heavier integration than this pipeline needs. A shared secret passed as a query parameter — compared with `crypto.timingSafeEqual`, never logged — is the standard workaround. If Jira Connect/Forge support is ever added here, prefer its signed-JWT scheme instead.

Both secrets are Secrets Manager ARNs supplied as deploy-time inputs (`GITHUB_WEBHOOK_SECRET_ARN`, `JIRA_WEBHOOK_SECRET_ARN`) — see "Setup" below. If unset, the receiver Lambda fails cleanly at invoke time with a clear error; synth/deploy still succeeds (same pattern as `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` in `docs/github-integration.md`).

## CloudWatch Logs Live Tail link

Ported directly from `.github/workflows/claude.yml`'s "Post CloudWatch log links" step (see [`web/amplify/functions/_shared/liveTail.ts`](../web/amplify/functions/_shared/liveTail.ts)):

- One log group per source repo/project: `/agent-webhook/<repo-or-project-slug>`
- One log stream per run, named by the run's UUID, created by `agent-webhook-post-comment` *before* the first comment is posted (so the very first Live Tail link is already valid)
- The console URL uses the same "rison" string codec as the Actions workflow (`enc()`: unreserved chars pass through, everything else becomes `*` + 2 lowercase hex digits), so both call sites produce byte-identical URL fragments for the same inputs

Unlike the Actions flow — which streams Claude Code's own OTel-exported tool calls and responses — this pipeline's log stream carries coarse markers written by the git-auth Lambda: the git-auth exec's stdout/stderr + exit code. The harness turn itself is the native `bedrockagentcore:invokeHarness` task, which runs without a Lambda, so its step-by-step reasoning isn't in this stream — the SFN console shows a per-turn CloudWatch link beside the InvokeHarness step for that (enable CloudWatch Transaction Search). Streaming the harness's own progress into this run's stream is left as a follow-up.

## Step Function

Defined in [`web/amplify/constructs/agentWebhookStack.ts`](../web/amplify/constructs/agentWebhookStack.ts) as a 4-state `Chain`: `LambdaInvoke` (post-initial) → `LambdaInvoke` (git-auth prep) → `CustomState` (native `bedrockagentcore:invokeHarness`) → `LambdaInvoke` (post-final), with a `Catch` on both the git-auth and invoke states routing to a failure-comment state. State input/output is threaded via JSONPath (`$.initialComment`, `$.prepared`, `$.agentResult`, `$.error`); `agent-webhook-post-comment` and the git-auth Lambda both branch on `source` (`github` | `jira`) internally.

`AgentWebhookStack` is provisioned in its **own CDK stack** (`backend.createStack('agent-webhook')`), not inside the existing `agentStack`. Building it inside `agentStack` created a circular nested-stack dependency: the state machine's `LambdaInvoke` tasks need the function-stack Lambdas' ARNs (function stack depends on this stack), while `agentStack` already depends on the function stack for other Lambdas' env vars. `agentWebhookReceiver`'s `states:StartExecution` permission is granted against a **plain-string ARN** (`arn:aws:states:<region>:<account>:stateMachine:<name>`) rather than `stateMachine.stateMachineArn`, for the same reason — the latter is a cross-stack CloudFormation token that would reintroduce the cycle. The native invoke task's `bedrock-agentcore:InvokeHarness` grant is added to the **state machine role** (`stateMachine.addToRolePolicy`), scoped to the harness ARN.

## Lambda functions

| Function | Role |
|---|---|
| [`agent-webhook-receiver`](../web/amplify/functions/agent-webhook-receiver/) | API Gateway target. Verifies signature, detects mention, `StartExecution` |
| [`agent-webhook-post-comment`](../web/amplify/functions/agent-webhook-post-comment/) | Posts initial (Live Tail link) and final comments, mints GitHub tokens |
| [`agent-webhook-invoke-agent`](../web/amplify/functions/agent-webhook-invoke-agent/) | Git-auth prep: seeds git credentials in the harness session via `InvokeAgentRuntimeCommand`, logs its stdout/stderr, returns the annotated prompt. (Despite the name, it no longer invokes the harness — that's the native SFN task.) |

`agent-webhook-post-comment` reuses [`web/amplify/functions/_shared/githubAppToken.ts`](../web/amplify/functions/_shared/githubAppToken.ts) — the GitHub App JWT/installation-token logic factored out of `mint-github-token` (see `docs/github-integration.md`) so both the browser-initiated flow and this webhook flow mint tokens identically.

The harness turn is the **native `bedrockagentcore:invokeHarness` Step Functions task** (see "Native harness invoke" above), which targets the **AgentCore Harness** (`MyHarness`) — the same target the browser-initiated `invoke-agent` Lambda uses. The harness authorizes with **AWS_IAM**; the native task signs with the state machine role, and the browser transport / `scripts/invoke.ts` sign the SDK's `InvokeHarnessCommand` with Cognito Identity Pool credentials.

> **Auth history.** The harness was originally `CUSTOM_JWT`-authorized (every caller sent a Cognito Bearer token to `POST /harnesses/invoke`). It was switched to `AWS_IAM` specifically so SigV4-only callers — the native `bedrockagentcore:invokeHarness` task and the `InvokeAgentRuntimeCommand` git-auth exec — work without a Cognito token. See the "Auth history" note in `docs/agentic-architecture.md` for the full rationale.

### Git access: harness exec (same session as the agent)

The harness runtime has its own shell but no `_prepare_workspace()` like the `AgUiHandler` runtime has. To give a GitHub run's agent write access, the git-auth Lambda (`agent-webhook-invoke-agent`, step 2) runs a setup command in the harness's runtime session via the **harness-exec API** — the SDK's `InvokeAgentRuntimeCommand` (`POST /runtimes/{harnessArn}/commands`) — **before** the native `invokeHarness` task, reusing the same `runtimeSessionId` (the Step Function's `runId`) for both so they land in the same container. (Verified empirically: a marker file written by an exec call is readable by the agent's code-interpreter tool in the same session.)

Two things here matter (both learned across #52/#53):

- **Path takes the harness ARN, not the backing runtime ARN.** Every `CfnHarness` exposes its backing runtime ARN (`CfnHarness.attrEnvironmentAgentCoreRuntimeEnvironmentAgentRuntimeArn`), but calling that ARN's exec endpoint directly returns HTTP 400 *"managed by a harness and cannot be invoked directly. Use the InvokeAgentRuntimeCommand API with the relevant harness ID instead."* So `InvokeAgentRuntimeCommand`'s `agentRuntimeArn` is set to the **harness** ARN.
- **Each operation is SigV4-signed against the harness ARN, by a different principal.** Now that the harness authorizes with `AWS_IAM`, the git-auth exec (`InvokeAgentRuntimeCommand`) is signed with the **git-auth Lambda's** execution role (granted `bedrock-agentcore:InvokeAgentRuntime` + `InvokeAgentRuntimeCommand` on the harness ARN), and the agent turn (native `invokeHarness` task) is signed with the **state machine's** role (granted `bedrock-agentcore:InvokeHarness` + `InvokeAgentRuntime`). (Under the earlier `CUSTOM_JWT` setup this SigV4 exec was rejected with HTTP 403 *"Authorization method mismatch"*, which is why the interim implementation used a Cognito Bearer token.)

The exec command:

1. Configures `git` identity (`user.name`/`user.email` → `webhook-agent[bot]`) and a **credential-store helper** seeded with the GitHub App installation token minted by `agent-webhook-post-comment` (`printf 'https://x-access-token:<token>@github.com' > ~/.git-credentials`) — the same token, the same minting path as the AgUiHandler's `_prepare_workspace()`. This makes `git clone`/`push` over HTTPS work with no interactive auth. The exec's stdout/stderr + exit code are written to the run's log stream and the Lambda's own log group for debugging.
2. The Lambda returns the prompt annotated with a `<github_access>` block (as `$.prepared.effectivePrompt`); the native `invokeHarness` task sends that to the agent, telling it `git` is already authenticated for the target repo so it clones/commits/pushes directly instead of assuming (as it did in early testing on #48) that it lacks write access.

**No `gh` CLI.** The harness image (Amazon Linux 2023) ships `git` but not `gh`, and `gh` can't be cleanly installed at exec time (no `cpio`, not in the AL2023 repos, `rpm -i` rejects the official package as non-relocatable). So the agent does **not** run `gh pr create`; instead the `<github_access>` block instructs it to push its branch and end its reply with a GitHub **compare URL** (`/compare/<base>...<head>?quick_pull=1&title=…&body=…`, per [GitHub's query-parameter docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/using-query-parameters-to-create-a-pull-request)). The Step Function posts the agent's reply back as an issue comment, so that one-click "open PR" link reaches the user there. Baking `gh` into the harness image (so `gh pr create` works directly) is tracked in #54.

The token travels once in the exec request body (TLS-encrypted, never surfaced to the model) and is stored only in the session's `~/.git-credentials` — the agent's subsequent tool calls never receive it.

## Setup

All inputs below are deploy-time environment variables read in `backend.ts`, mirroring `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` in `docs/github-integration.md`. None are created by this stack.

| Env var | Required for | Value |
|---|---|---|
| `GITHUB_APP_ID` | GitHub comments | Same GitHub App as `docs/github-integration.md` |
| `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` | GitHub comments | Same secret as `docs/github-integration.md` |
| `GITHUB_WEBHOOK_SECRET_ARN` | GitHub comments | Secrets Manager ARN of a secret whose value is the webhook's HMAC secret |
| `JIRA_WEBHOOK_SECRET_ARN` | Jira comments | Secrets Manager ARN of the shared secret used in `?secret=` |
| `JIRA_BASE_URL` | Jira comments | e.g. `https://your-domain.atlassian.net` |
| `JIRA_API_EMAIL` | Jira comments | Email of the Jira account whose API token is below |
| `JIRA_API_TOKEN_SECRET_ARN` | Jira comments | Secrets Manager ARN of a [Jira API token](https://id.atlassian.com/manage-profile/security/api-tokens) |

After `pnpm deploy`, register the webhook on the repo. For **GitHub**, use the scripted setup — it reads `custom.agent_webhook_url` from `amplify_outputs.json`, pulls the HMAC secret straight from the deployed receiver Lambda's `GITHUB_WEBHOOK_SECRET_ARN` (so the registered secret can't drift from what the backend verifies), and creates-or-updates the hook idempotently:

```bash
npx tsx scripts/setup-github-webhook.ts --repo owner/name
```

Re-running it just updates the existing hook in place (matched by payload URL) — no duplicates. To register manually instead: repo → Settings → Webhooks → Add webhook, Payload URL = `agent_webhook_url`, content type `application/json`, secret = the value stored at `GITHUB_WEBHOOK_SECRET_ARN`, events = "Issue comments" only.

- **Jira**: Settings → System → WebHooks → Create a WebHook. URL = `<agent_webhook_url>?source=jira&secret=<value stored at JIRA_WEBHOOK_SECRET_ARN>`, event = "Comment created".

Mention the agent with `@webhook-agent <your request>` in a GitHub issue/PR comment or a Jira issue comment.

## Loop prevention

GitHub: the receiver ignores comments from `sender.type === 'Bot'` or logins ending in `[bot]` — same check as `scripts/github-agent-invoke.ts`. Jira has no bot-sender concept in its webhook payload; since the final-comment poster doesn't itself match `@webhook-agent`, there's no reply loop regardless.
