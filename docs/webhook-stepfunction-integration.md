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
             • invokes the AgentCore Harness (/harnesses/invoke, authenticated
               as the invoke-agent Cognito service account) with the comment's
               prompt, and decodes the binary event stream into the full text
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

Unlike the Actions flow — which streams Claude Code's own OTel-exported tool calls and responses — this pipeline's log stream only carries coarse progress markers (`invoking agent`, a 20s heartbeat, `agent responded (N chars)`, or the failure message) written by `agent-webhook-invoke-agent`. The harness `/harnesses/invoke` call is a single blocking event-stream read fully consumed before the Lambda returns — the coarse markers are all this path surfaces without having the harness stream step-by-step progress lines into this run's log stream directly. Left as a follow-up.

## Step Function

Defined in [`web/amplify/constructs/agentWebhookStack.ts`](../web/amplify/constructs/agentWebhookStack.ts) as a 3-state `Chain` (`LambdaInvoke` → `LambdaInvoke` → `LambdaInvoke`, with a `Catch` on the middle state). State input/output is threaded via JSONPath (`$.initialComment`, `$.agentResult`, `$.error`) rather than a Lambda-per-source-type branch — `agent-webhook-post-comment` and `agent-webhook-invoke-agent` both branch on `source` (`github` | `jira`) internally.

`AgentWebhookStack` is provisioned in its **own CDK stack** (`backend.createStack('agent-webhook')`), not inside the existing `agentStack`. Building it inside `agentStack` created a circular nested-stack dependency: the state machine's `LambdaInvoke` tasks need the function-stack Lambdas' ARNs (function stack depends on this stack), while `agentStack` already depends on the function stack for other Lambdas' env vars. `agentWebhookReceiver`'s `states:StartExecution` permission is granted against a **plain-string ARN** (`arn:aws:states:<region>:<account>:stateMachine:<name>`) rather than `stateMachine.stateMachineArn`, for the same reason — the latter is a cross-stack CloudFormation token that would reintroduce the cycle.

## Lambda functions

| Function | Role |
|---|---|
| [`agent-webhook-receiver`](../web/amplify/functions/agent-webhook-receiver/) | API Gateway target. Verifies signature, detects mention, `StartExecution` |
| [`agent-webhook-post-comment`](../web/amplify/functions/agent-webhook-post-comment/) | Posts initial (Live Tail link) and final comments, mints GitHub tokens |
| [`agent-webhook-invoke-agent`](../web/amplify/functions/agent-webhook-invoke-agent/) | Invokes the AgentCore Harness via `/harnesses/invoke` (Cognito service-account JWT) |

`agent-webhook-post-comment` reuses [`web/amplify/functions/_shared/githubAppToken.ts`](../web/amplify/functions/_shared/githubAppToken.ts) — the GitHub App JWT/installation-token logic factored out of `mint-github-token` (see `docs/github-integration.md`) so both the browser-initiated flow and this webhook flow mint tokens identically.

`agent-webhook-invoke-agent` invokes the **AgentCore Harness** (`MyHarness`), not the `AgUiHandler` runtime — the same target the browser-initiated `invoke-agent` Lambda uses. The harness authorizes with **CUSTOM_JWT** (Cognito), so a raw SigV4 `InvokeAgentRuntimeCommand` against the runtime fails with an `Authorization method mismatch` error. Instead this Lambda authenticates as the `invoke-agent-service` Cognito user (password read from the shared SSM parameter `/agentcore/invoke-agent-service/password`), then `POST`s to `https://bedrock-agentcore.<region>.amazonaws.com/harnesses/invoke?harnessArn=<arn>` with a `Bearer` token and decodes the returned AWS binary event stream's `contentBlockDelta` frames into the full response text — identical framing logic to `web/amplify/functions/invoke-agent/handler.ts` and `scripts/invoke.ts`.

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
