# GitHub Integration

Agents in this project can be invoked by @mentioning them in GitHub issue and PR comments. The integration uses GitHub Actions with a dedicated IAM user — long-term credentials are stored as GitHub secrets and used to sign requests directly to the AgentCore runtime.

## How it works

```
issue_comment event
    │
    ▼
GitHub Actions workflow  (.github/workflows/agent-mention.yml)
    │
    ├─ Parse @agent-<slug> mention from comment body
    ├─ SigV4-sign createChatSession mutation → AppSync (IAM auth)
    │    returns chatSessionId
    ├─ Post live-link comment: "Watch live: <APP_URL>/chat-handler?sessionId=<id>"
    ├─ SigV4-sign POST /runtimes/<arn>/invocations?qualifier=DEFAULT  (sync: true)
    │    payload includes sessionId, githubToken, githubRepo, githubBranch
    │
    ▼
AgentCore runtime  (agent/handler/agent.py — FastAPI + Strands)
    │  clones repo, runs agent, publishes AG-UI events to AppSync subscription
    │  returns {"sessionId": "...", "response": "..."}
    │
    ▼
octokit.rest.issues.createComment  (final reply posted as github-actions[bot])
```

The runtime runs in **sync mode** (`sync: true` in the invocation payload): it processes the prompt inline and returns the full response in the HTTP body instead of publishing AG-UI events to AppSync. This avoids the need for a WebSocket subscription in the Actions runner.

## Setup

Run the setup script (from repo root):

```bash
npx tsx scripts/setup-github-integration.ts
# interactive repo picker

npx tsx scripts/setup-github-integration.ts --repo owner/name
# non-interactive
```

The script:

1. Reads the AgUiHandler runtime ARN from `web/deployment-info.json`
2. Creates the IAM user `github-actions-agent-invoker` if it doesn't exist and upserts an inline policy:
   ```json
   {
     "Effect": "Allow",
     "Action": "bedrock-agentcore:InvokeAgentRuntime",
     "Resource": ["<runtimeArn>", "<runtimeArn>/runtime-endpoint/*"]
   }
   ```
3. Reuses the existing IAM access key (the secret is already in GitHub from a prior run) or creates a new one if none exist
4. Sets the `INVOKE_AGENT_RUNTIME_ARN` Actions variable and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` secrets on the target repo
5. Pushes `scripts/github-agent-invoke.ts` and `.github/workflows/agent-mention.yml` to the target repo via the GitHub Contents API

### Prerequisites

- `gh` CLI authenticated (`gh auth login`)
- AWS CLI configured with admin credentials for the deployment account
- `pnpm deploy` completed (`web/deployment-info.json` must exist)

## Repository variables and secrets

| Name | Type | Description |
|------|------|-------------|
| `INVOKE_AGENT_RUNTIME_ARN` | Variable | ARN of the AgUiHandler AgentCore runtime |
| `APPSYNC_ENDPOINT` | Variable | AppSync GraphQL endpoint URL (for creating chat sessions) |
| `APP_URL` | Variable | Base URL of the deployed web app (optional, enables live-chat links) |
| `AWS_ACCESS_KEY_ID` | Secret | Access key ID for `github-actions-agent-invoker` IAM user |
| `AWS_SECRET_ACCESS_KEY` | Secret | Secret key for `github-actions-agent-invoker` IAM user |

`AWS_REGION` is hardcoded to the deployment region in the generated workflow.

Pass `--app-url https://your-app.example.com` to `setup-github-integration.ts` to set `APP_URL`.

## Workflow

The generated `.github/workflows/agent-mention.yml`:

```yaml
name: Agent @mention handler

on:
  issue_comment:
    types: [created]
  issues:
    types: [assigned]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  invoke-agent:
    runs-on: ubuntu-latest
    if: |
      github.event.sender.type != 'Bot' && (
        github.event_name == 'issues' ||
        contains(github.event.comment.body, '@agent-')
      )
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install script dependencies
        run: npm install --no-save tsx @octokit/rest @smithy/signature-v4 @aws-crypto/sha256-js
      - name: Invoke agent and post reply
        env:
          INVOKE_AGENT_RUNTIME_ARN: ${{ vars.INVOKE_AGENT_RUNTIME_ARN }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_BASE_REF: ${{ github.event.repository.default_branch }}
        run: npx tsx scripts/github-agent-invoke.ts
```

## SigV4 signing

`scripts/github-agent-invoke.ts` uses `@smithy/signature-v4` to sign the runtime invocation:

- Service: `bedrock-agentcore`
- Region: `us-east-1`
- Endpoint: `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/<encoded-arn>/invocations`
- Query param `qualifier=DEFAULT` is separated from the path before signing (required for correct signature)
- The `host` header is stripped from signed headers before calling `fetch` (fetch injects it automatically from the URL)

## Prompt construction

The invoke script builds a prompt that includes structured GitHub context:

```
You are acting on behalf of a GitHub user in the repository <owner>/<repo>.

CONTEXT:
- Repository: <owner>/<repo>
- Default branch: <branch>
- Issue #<N>: <title>
- Issue body: <first 500 chars>
- Triggered by: @<sender>

USER REQUEST:
<text after @agent-<slug>>

If your response involves code changes, create a new branch off <branch>,
commit the changes, and open a pull request. Reference issue #<N> in the PR description.
```

## Loop prevention

The workflow's `if` condition excludes `Bot` sender types. The script additionally checks `sender.login.endsWith('[bot]')` before processing, so the bot never responds to its own comments.

## Trigger strategies

| Trigger | Event | How to target an agent |
|---------|-------|------------------------|
| @mention in comment | `issue_comment.created` | Include `@agent-<slug>` in comment body |
| Issue assignment | `issues.assigned` | Issue body must contain `@agent-<slug>` |
| PR comment | `issue_comment.created` | Comment on a PR (same event, `issue.pull_request` field is present) |

## Workspace cloning

When the invocation payload includes `githubToken`, `githubRepo`, and `githubBranch`, the runtime prepares a workspace **before** the agent runs:

1. **`gh` CLI is authenticated** via `gh auth login --with-token` (token piped to stdin, stored in `~/.config/gh/hosts.yml`). The agent never sees the token.
2. **`gh auth setup-git`** is run to register `gh` as git's HTTPS credential helper, so all plain git operations authenticate automatically without any token in URLs or config.
3. **Repository is cloned** into `/workspace/<owner>/<repo>` on the default branch, or updated with `git fetch` + `git reset --hard` if the directory already exists. No token appears in `.git/config`.
4. The workspace path and usage hints are injected into the agent's system prompt. The agent decides whether to create a branch, and can push any branch (new or existing) directly:
   ```
   git -C /workspace/<owner>/<repo> checkout -b my-feature-branch
   git -C /workspace/<owner>/<repo> push origin my-feature-branch
   gh pr create --repo <owner>/<repo> --base main --head my-feature-branch --title '...' --body '...'
   ```

The `GITHUB_TOKEN` from Actions has `contents: write` and `pull-requests: write` permissions (declared in the workflow). Its default expiry is the job timeout (up to 6 hours).

## Browser-initiated sessions: minting scoped tokens with a GitHub App

The Actions integration above gets its token for free — `GITHUB_TOKEN` is already scoped to the triggering repo and expires with the job. Browser-initiated sessions (`/chat-handler`, via `invokeHandler`) have no equivalent: there's no Actions runner providing a token, so a long-lived PAT is the only easy alternative. This project avoids that by minting a **short-lived, repo-scoped GitHub App installation access token per invocation** instead.

### Why a GitHub App instead of a PAT

| | Long-lived PAT | GitHub App installation token |
|---|---|---|
| Lifetime | Until manually revoked (often never) | ~1 hour, minted per request |
| Scope | Usually all repos the user can access | Exactly the repos the App is installed on, exactly the permissions granted (`contents:write`, `pull_requests:write`) |
| Storage | A secret that must be stored *somewhere* long-term (Secrets Manager, GitHub secret, `.env`) and rotated manually | The App's private key is the only long-lived secret; it never leaves Secrets Manager and never signs anything a user can act as — it only mints installation tokens |
| Revocation blast radius | Revoking breaks every consumer of that PAT | Uninstalling the App or narrowing its repo selection revokes access immediately, per-repo |

The tradeoff is setup complexity: a GitHub App must be created once (manual step, see below), and its private key must be seeded into Secrets Manager. The Actions path (`.github/workflows/agent-mention.yml`) is intentionally left as-is — it already has a correctly-scoped, auto-expiring token via `GITHUB_TOKEN`, so there's nothing to improve there.

### Architecture

```
Browser (/chat-handler)
    │
    ├─ mintGithubToken(repo) mutation → AppSync → mint-github-token Lambda
    │     1. Reads the App's PKCS8 private key from Secrets Manager (by ARN)
    │     2. Signs a short-lived (≤10 min) App JWT (RS256, via `jose`)
    │     3. GET /repos/<repo>/installation  → installation ID
    │     4. POST /app/installations/<id>/access_tokens
    │          { repositories: [<name>], permissions: { contents: write, pull_requests: write } }
    │     returns { token, expiresAt }              (token never persisted server-side)
    │
    ├─ invokeHandler(sessionId, prompt, githubToken, githubRepo, githubBranch) mutation
    │
    ▼
AgentCore runtime (agent/handler/agent.py) — same _prepare_workspace() path as the
Actions integration: gh auth login --with-token, gh auth setup-git, clone. The agent
itself never sees the token (see "Workspace cloning" above).
```

`mintGithubToken` and `invokeHandler` are separate mutations — the frontend calls the former immediately before the latter, so the token is minted fresh for (essentially) every run rather than cached and reused across sessions.

### Lambda: `mint-github-token`

Source: [`web/amplify/functions/mint-github-token/`](../web/amplify/functions/mint-github-token/). Reads two env vars, wired in `backend.ts`:

| Env var | Value |
|---|---|
| `GITHUB_APP_ID` | The App's numeric ID (from the App's settings page) |
| `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` | ARN of a Secrets Manager secret whose `SecretString` is the App's PKCS8 PEM private key |

Both are deploy-time inputs read from `process.env` in `backend.ts` — they are **not** created by this stack, and neither is ever hardcoded or committed. If `GITHUB_APP_PRIVATE_KEY_SECRET_ARN` is unset, the Lambda's IAM policy grants no Secrets Manager access and `mintGithubToken` fails at invoke time with a clear error (the rest of the stack still deploys — this mirrors how `AGENTCORE_GATEWAY_ARN` is treated elsewhere in `backend.ts`).

The GraphQL schema for this mutation lives in [`web/amplify/data/schemas/github.schema.ts`](../web/amplify/data/schemas/github.schema.ts); it requires `allow.authenticated()`, same as `invokeHandler`.

### One-time setup: creating the GitHub App

1. **Create the App** — GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   - Repository permissions: **Contents: Read & write**, **Pull requests: Read & write**. No other permissions needed.
   - Webhook: disable (this integration doesn't use webhooks — see the sibling issue for a future webhook/Step Function invoker).
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

### Frontend wiring

`/chat-handler`'s `sendMessage` (in [`web/app/(with-auth)/chat-handler/page.tsx`](../web/app/(with-auth)/chat-handler/page.tsx)) does not yet call `mintGithubToken` — today it only sends `sessionId`, `prompt`, `systemPrompt`, `modelId`. Wiring a repo-picker UI and calling `mintGithubToken` before `invokeHandler` is left for a follow-up; this issue's scope was the token-minting Lambda and its AppSync surface, per the "Scope" section in issue #34.

## Sync mode in the runtime

`agent/handler/agent.py` checks for `sync: true` in the invocation payload:

```python
if sync_mode:
    response_text = await _run_agent(session_id, prompt, system_prompt, model_id, ...)
    return JSONResponse({"sessionId": session_id, "response": response_text})
```

In sync mode, AppSync event publishing is skipped gracefully when credentials are unavailable (boto3 returns `None` from `get_credentials()` in environments without an IAM role). The Strands agent still calls Bedrock normally using the container's execution role.
