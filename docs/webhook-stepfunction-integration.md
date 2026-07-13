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
        • detects the "@webhook-agent" mention
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
        2. agent-webhook-invoke-agent
             • GitHub only: execs a git credential-store setup in the harness's
               runtime session (InvokeAgentRuntimeCommand → POST
               /runtimes/{harnessArn}/commands, SigV4) before the agent runs —
               see "Git access" below
             • invokes the AgentCore Harness (InvokeHarnessCommand, SigV4-signed
               with the Lambda's execution role) with the comment's prompt; the
               SDK decodes the event stream into the full text
             • appends heartbeat lines to the run's log stream
             • on failure: Catch → agent-webhook-post-comment (stage=final)
               posts the error instead
        3. agent-webhook-post-comment (stage=final)
             • posts the agent's response as a follow-up comment
```

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

Unlike the Actions flow — which streams Claude Code's own OTel-exported tool calls and responses — this pipeline's log stream only carries coarse progress markers (`invoking agent`, a 20s heartbeat, `agent responded (N chars)`, or the failure message) written by `agent-webhook-invoke-agent`. The `InvokeHarness` call is a single blocking event-stream read fully consumed before the Lambda returns — the coarse markers are all this path surfaces without having the harness stream step-by-step progress lines into this run's log stream directly. Left as a follow-up.

## Browser chat live view

`agent-webhook-receiver` creates a `ChatSession` row (`id = runId`) before calling `StartExecution`, and that same `runId` is reused unchanged as the harness `runtimeSessionId` in `agent-webhook-invoke-agent`. Since the harness always writes memory under `actorId = "default"` — the same actor the browser's `list-session-messages` Lambda reads — a single id ties the webhook run to a session the browser can load directly: `/chat?sessionId=<runId>` shows that run's messages once the agent has produced any (see `web/app/(with-auth)/chat/use-chat-session.ts` / `use-initial-messages.ts`). No separate id-mapping table is needed. This is the foundational piece of the "Webhook chat-session live view" milestone (issue #61); the ChatSession write is best-effort and never blocks starting the agent run if it fails.

The `ChatSession` row is written with a raw `dynamodb:PutItem` (env var `CHAT_SESSION_TABLE`, granted via `backend.data.resources.tables['ChatSession']` in `backend.ts`) rather than the generated Amplify Data client — same pattern `invoke-agent/handler.ts` uses to read the `Agent`/`McpServer` tables directly, since IAM-only Lambda access to a model's DynamoDB table doesn't require the AppSync-mediated `allow.resource()` grant.

## Step Function

Defined in [`web/amplify/constructs/agentWebhookStack.ts`](../web/amplify/constructs/agentWebhookStack.ts) as a 3-state `Chain` (`LambdaInvoke` → `LambdaInvoke` → `LambdaInvoke`, with a `Catch` on the middle state). State input/output is threaded via JSONPath (`$.initialComment`, `$.agentResult`, `$.error`) rather than a Lambda-per-source-type branch — `agent-webhook-post-comment` and `agent-webhook-invoke-agent` both branch on `source` (`github` | `jira`) internally.

`AgentWebhookStack` is provisioned in its **own CDK stack** (`backend.createStack('agent-webhook')`), not inside the existing `agentStack`. Building it inside `agentStack` created a circular nested-stack dependency: the state machine's `LambdaInvoke` tasks need the function-stack Lambdas' ARNs (function stack depends on this stack), while `agentStack` already depends on the function stack for other Lambdas' env vars. `agentWebhookReceiver`'s `states:StartExecution` permission is granted against a **plain-string ARN** (`arn:aws:states:<region>:<account>:stateMachine:<name>`) rather than `stateMachine.stateMachineArn`, for the same reason — the latter is a cross-stack CloudFormation token that would reintroduce the cycle.

## Lambda functions

| Function | Role |
|---|---|
| [`agent-webhook-receiver`](../web/amplify/functions/agent-webhook-receiver/) | API Gateway target. Verifies signature, detects mention, `StartExecution` |
| [`agent-webhook-post-comment`](../web/amplify/functions/agent-webhook-post-comment/) | Posts initial (Live Tail link) and final comments, mints GitHub tokens |
| [`agent-webhook-invoke-agent`](../web/amplify/functions/agent-webhook-invoke-agent/) | Invokes the AgentCore Harness via the SDK's `InvokeHarnessCommand` (SigV4, Lambda execution role) |

`agent-webhook-post-comment` reuses [`web/amplify/functions/_shared/githubAppToken.ts`](../web/amplify/functions/_shared/githubAppToken.ts) — the GitHub App JWT/installation-token logic factored out of `mint-github-token` (see `docs/github-integration.md`) so both the browser-initiated flow and this webhook flow mint tokens identically.

`agent-webhook-invoke-agent` invokes the **AgentCore Harness** (`MyHarness`), not the `AgUiHandler` runtime — the same target the browser-initiated `invoke-agent` Lambda uses. The harness authorizes with **AWS_IAM**, so this Lambda calls the SDK's `InvokeHarnessCommand` signed with its own execution-role credentials (SigV4) — no Cognito service account / SSM password. The SDK decodes the event stream's `contentBlockDelta` events into the full response text and owns connection timeouts + retries, which is what retired the hand-rolled binary decoder and the long-stream `TypeError: terminated` (#57). The `invoke-agent` Lambda, the browser transport, and `scripts/invoke.ts` all use the same `InvokeHarnessCommand` path; the browser signs with Cognito Identity Pool credentials rather than the Lambda role.

> **Auth history.** The harness was originally `CUSTOM_JWT`-authorized (every caller sent a Cognito Bearer token to `POST /harnesses/invoke`). It was switched to `AWS_IAM` specifically so the webhook path could use the native SigV4-only `InvokeHarness` / `InvokeAgentRuntimeCommand` SDK operations — see the "Auth history" note in `docs/agentic-architecture.md` for the full rationale.

### Git access: harness exec (same session as the agent)

The harness runtime has its own shell but no `_prepare_workspace()` like the `AgUiHandler` runtime has. To give a GitHub run's agent write access, `agent-webhook-invoke-agent` runs a setup command in the harness's runtime session via the **harness-exec API** — the SDK's `InvokeAgentRuntimeCommand` (`POST /runtimes/{harnessArn}/commands`) — **before** the `InvokeHarness` call, reusing the same `runtimeSessionId` (the Step Function's `runId`) for both so they land in the same container. (Verified empirically: a marker file written by an exec call is readable by the agent's code-interpreter tool in the same session.)

Two things here matter (both learned across #52/#53):

- **Path takes the harness ARN, not the backing runtime ARN.** Every `CfnHarness` exposes its backing runtime ARN (`CfnHarness.attrEnvironmentAgentCoreRuntimeEnvironmentAgentRuntimeArn`), but calling that ARN's exec endpoint directly returns HTTP 400 *"managed by a harness and cannot be invoked directly. Use the InvokeAgentRuntimeCommand API with the relevant harness ID instead."* So `InvokeAgentRuntimeCommand`'s `agentRuntimeArn` is set to the **harness** ARN.
- **Both operations are SigV4-signed against the harness ARN.** Now that the harness authorizes with `AWS_IAM`, exec (`InvokeAgentRuntimeCommand`) and the agent turn (`InvokeHarness`) are both signed with the Lambda's execution-role credentials. The Lambda role is granted `bedrock-agentcore:InvokeHarness` **and** `bedrock-agentcore:InvokeAgentRuntimeCommand` on the harness ARN. (Under the earlier `CUSTOM_JWT` setup this SigV4 exec was rejected with HTTP 403 *"Authorization method mismatch"*, which is why the interim implementation used a Cognito Bearer token.)

The exec command:

1. Configures `git` identity (`user.name`/`user.email` → `webhook-agent[bot]`) and a **credential-store helper** seeded with the GitHub App installation token minted by `agent-webhook-post-comment` (`printf 'https://x-access-token:<token>@github.com' > ~/.git-credentials`) — the same token, the same minting path as the AgUiHandler's `_prepare_workspace()`. This makes `git clone`/`push` over HTTPS work with no interactive auth.
2. The prompt sent to `InvokeHarness` is annotated with a `<github_access>` block telling the agent its `git` is already authenticated for the target repo, so it clones/commits/pushes directly instead of assuming (as it did in early testing on #48) that it lacks write access.

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
