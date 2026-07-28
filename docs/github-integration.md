# GitHub Integration

> **The Actions-based `@agent-<slug>` mention flow described in earlier versions of this
> document has been removed (#191).** It ran `.github/workflows/agent-mention.yml` →
> `scripts/github-agent-invoke.ts` against the `AgUiHandler` AgentCore runtime, which was
> itself retired in #33 — so the workflow had been dead (fully commented out, failing CI
> on every push) since then. `scripts/setup-github-integration.ts`, the generator that
> wrote the workflow, was removed alongside it.
>
> **@mentioning an agent in a GitHub issue/PR comment is now handled by the webhook +
> Step Function pipeline** — see
> [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md).
> Mention `@agentcore <request>` (routes to `MyHarness`) or `@agentcore-claude <request>`
> (routes to the Claude Code AgentCore Runtime), or apply the `agentcore` label to an
> issue/PR.

This document now covers only the GitHub App used to mint short-lived, repo-scoped
tokens — the piece that's independent of the retired Actions flow.

## Browser-initiated sessions: minting scoped tokens with a GitHub App

> **Note:** `mintGithubToken` is deployed (Lambda + AppSync mutation) but currently has
> no caller — the `/chat-handler` page it was built for was removed alongside the
> `AgUiHandler` runtime in #33. The webhook pipeline (`docs/webhook-stepfunction-integration.md`)
> mints its own installation tokens via the same underlying helper
> (`web/amplify/functions/_shared/githubAppToken.ts`), independently of this mutation.

Long-lived PATs are the easy alternative for minting a GitHub token outside of a GitHub
Actions runner context (where `GITHUB_TOKEN` is provided for free, scoped and
auto-expiring). This project avoids PATs by minting a **short-lived, repo-scoped GitHub
App installation access token per invocation** instead.

### Why a GitHub App instead of a PAT

| | Long-lived PAT | GitHub App installation token |
|---|---|---|
| Lifetime | Until manually revoked (often never) | ~1 hour, minted per request |
| Scope | Usually all repos the user can access | Exactly the repos the App is installed on, exactly the permissions granted (`contents:write`, `pull_requests:write`) |
| Storage | A secret that must be stored *somewhere* long-term (Secrets Manager, GitHub secret, `.env`) and rotated manually | The App's private key is the only long-lived secret; it never leaves Secrets Manager and never signs anything a user can act as — it only mints installation tokens |
| Revocation blast radius | Revoking breaks every consumer of that PAT | Uninstalling the App or narrowing its repo selection revokes access immediately, per-repo |

The tradeoff is setup complexity: a GitHub App must be created once (manual step, see
below), and its private key must be seeded into Secrets Manager.

### Architecture

```
Browser
    │
    ├─ mintGithubToken(repo) mutation → AppSync → mint-github-token Lambda
    │     1. Reads the App's PKCS8 private key from Secrets Manager (by ARN)
    │     2. Signs a short-lived (≤10 min) App JWT (RS256, via `jose`)
    │     3. GET /repos/<repo>/installation  → installation ID
    │     4. POST /app/installations/<id>/access_tokens
    │          { repositories: [<name>], permissions: { contents: write, pull_requests: write } }
    │     returns { token, expiresAt }              (token never persisted server-side)
```

`mintGithubToken` has no current caller (see note above) — it's kept deployed in case a
future browser-initiated flow needs a scoped token minted this way.

### Lambda: `mint-github-token`

Source: [`web/amplify/functions/mint-github-token/`](../web/amplify/functions/mint-github-token/). Reads two env vars, wired in `backend.ts`:

| Env var | Value |
|---|---|
| `GITHUB_APP_ID` | The App's numeric ID (from the App's settings page) |
| `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` | ARN of a Secrets Manager secret whose `SecretString` is the App's PKCS8 PEM private key |

Both are deploy-time inputs read from `process.env` in `backend.ts` — they are **not**
created by this stack, and neither is ever hardcoded or committed. If
`GITHUB_APP_PRIVATE_KEY_SECRET_ARN` is unset, the Lambda's IAM policy grants no Secrets
Manager access and `mintGithubToken` fails at invoke time with a clear error (the rest
of the stack still deploys — this mirrors how `AGENTCORE_GATEWAY_ARN` is treated
elsewhere in `backend.ts`).

The GraphQL schema for this mutation lives in
[`web/amplify/data/schemas/github.schema.ts`](../web/amplify/data/schemas/github.schema.ts);
it requires `allow.authenticated()`.

### One-time setup: creating the GitHub App

1. **Create the App** — GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   - Repository permissions: **Contents: Read & write**, **Pull requests: Read & write**. No other permissions needed.
   - Webhook: disable (the App's own webhook feature isn't used here — the pipeline in [`docs/webhook-stepfunction-integration.md`](./webhook-stepfunction-integration.md), which reuses this same App for its GitHub path, registers a separate repo webhook via `scripts/setup-github-webhook.ts`).
   - "Where can this GitHub App be installed?": Only on this account, unless you need it across an org.
2. **Generate a private key** on the App's settings page — downloads a `.pem` file. This is the only long-lived secret in this flow.
3. **Store the private key in Secrets Manager**, e.g.:
   ```bash
   aws secretsmanager create-secret \
     --name github-app/agents4energy/private-key \
     --secret-string file://path/to/downloaded-key.pem
   ```
   Note the resulting secret ARN.
4. **Install the App** on the target repo(s) — from the App's settings page, "Install App".
5. **Set the two env vars** before running `pnpm deploy` (or your CI deploy step):
   ```bash
   export GITHUB_APP_ID=123456
   export GITHUB_APP_PRIVATE_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:111122223333:secret:github-app/agents4energy/private-key-AbCdEf
   ```
