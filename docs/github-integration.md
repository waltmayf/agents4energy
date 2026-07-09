# GitHub Integration

Agents in this project can be invoked by @mentioning them in GitHub issue and PR comments. The integration uses GitHub Actions with a dedicated IAM role (OIDC) — no long-lived AWS credentials are stored as secrets.

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
    ├─ Post live-link comment: "Watch live: <APP_URL>/chat?sessionId=<id>"
    ├─ SigV4-sign POST /harnesses/invoke?harnessArn=<arn>
    │    payload: { sessionId, runtimeSessionId, messages }
    │
    ▼
AgentCore Harness  (MyHarness — declared inline in web/amplify/backend.ts)
    │  runs the model with its configured agentcore_browser / agentcore_code_interpreter
    │  tools, streams a binary event-stream response
    │
    ▼
octokit.rest.issues.createComment  (final reply posted as github-actions[bot])
```

`scripts/github-agent-invoke.ts` decodes the harness's binary event-stream response inline and posts the assembled text as the final comment — there's no separate sync/async mode; every invocation is synchronous from the script's perspective.

**Note:** the managed harness has no filesystem or `git`/`gh` tooling — only its configured `agentcore_browser` and `agentcore_code_interpreter` tools. It cannot clone a repo, create branches, or open PRs on its own. If you need the agent to push code changes from a GitHub-triggered run, use the Claude Code Action workflow (`.github/workflows/claude.yml`) instead, which runs in a full Actions runner with `git`/`gh` available.

## Setup

Run the setup script (from repo root):

```bash
npx tsx scripts/setup-github-integration.ts
# interactive repo picker

npx tsx scripts/setup-github-integration.ts --repo owner/name
# non-interactive
```

The script:

1. Reads AppSync + region info from `web/amplify_outputs.json`
2. Creates (or reuses) a GitHub OIDC IAM role scoped to AppSync `createChatSession` + `invokeAgent` field-level ARNs, and sets `AWS_AGENT_ROLE_ARN` as a GitHub Actions secret on the target repo
3. Sets `APPSYNC_ENDPOINT` and `APP_URL` as Actions variables
4. Pushes `.github/workflows/agent-mention.yml` to the target repo via the GitHub Contents API

### Prerequisites

- `gh` CLI authenticated (`gh auth login`)
- AWS CLI configured with admin credentials for the deployment account
- `pnpm deploy` completed (`web/amplify_outputs.json` must exist)

## Repository variables and secrets

| Name | Type | Description |
|------|------|-------------|
| `AWS_AGENT_ROLE_ARN` | Secret | OIDC role the workflow assumes via `aws-actions/configure-aws-credentials` |
| `APPSYNC_ENDPOINT` | Variable | AppSync GraphQL endpoint URL (for creating chat sessions) |
| `APP_URL` | Variable | Base URL of the deployed web app (optional, enables live-chat links) |

`AWS_REGION` is hardcoded to the deployment region in the generated workflow.

Pass `--app-url https://your-app.example.com` to `setup-github-integration.ts` to set `APP_URL`.

## Workflow

`.github/workflows/agent-mention.yml` is committed in a disabled (fully commented-out) state — see the file for the exact steps. When enabled, it:

1. Reacts 👀 to the triggering comment
2. Assumes the OIDC role via `aws-actions/configure-aws-credentials`
3. Creates a `ChatSession` via AppSync and posts a live-link comment
4. Invokes the agent (via the `invokeAgent` AppSync mutation, which the `invoke-agent` Lambda forwards to the AgentCore harness) and posts the response as a comment

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

Since the harness has no `git`/`gh` tooling, this last instruction only matters when the workflow is adapted to fall through to the Claude Code Action instead of invoking the harness directly.

## Loop prevention

The workflow's `if` condition excludes `Bot` sender types. The script additionally checks `sender.login.endsWith('[bot]')` before processing, so the bot never responds to its own comments.

## Trigger strategies

| Trigger | Event | How to target an agent |
|---------|-------|------------------------|
| @mention in comment | `issue_comment.created` | Include `@agent-<slug>` in comment body |
| Issue assignment | `issues.assigned` | Issue body must contain `@agent-<slug>` |
| PR comment | `issue_comment.created` | Comment on a PR (same event, `issue.pull_request` field is present) |
