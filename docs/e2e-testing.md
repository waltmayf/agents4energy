# E2E Testing with Playwright

Tests live in [web/e2e/](../web/e2e/) and run against either a local Next.js dev server (`https://localhost:3000`) or an already-deployed branch (CloudFront + S3), depending on whether `web/e2e-config.json` is present.

## Quick start

```bash
cd web

# Run all tests (headless)
pnpm test:e2e

# Interactive UI mode — live browser, time-travel debugging
pnpm test:e2e:ui

# Run a single test file
pnpm test:e2e e2e/chat.spec.ts

# Run with headed browser (visible window)
pnpm test:e2e --headed
```

The dev server starts automatically. If it's already running, Playwright reuses it.

## Running against a deployed branch (no local build required)

Every deploy (`pnpm deploy` locally, or the CI `Deploy` workflow) publishes a small e2e config — the CloudFront app URL and Cognito user pool info — to SSM Parameter Store at `/outputs/<owner>-<repo>/<branch>/e2e-config`, keyed by repo and branch so concurrent branches don't collide. `scripts/fetch-e2e-config.ts` reads it back by deriving that same path from the current repo + branch — no CloudFormation lookup.

> **Note:** the publish side is being migrated to a CDK-owned `aws_ssm.StringParameter` in `web/amplify/backend.ts` so it lands on every `ampx sandbox --once` (local and CI alike), replacing the old `scripts/extract-deployment-info.js` step. See [#82](https://github.com/waltmayf/agents4energy/issues/82).

To run the full e2e suite from a fresh checkout, on a branch that has already been deployed, with no local `ampx sandbox` or `pnpm build` step:

```bash
# From the repo root — fetches config for the current git branch into web/e2e-config.json
pnpm fetch:e2e-config

cd web
pnpm test:e2e
```

Requires AWS credentials with `ssm:GetParameter` on `/outputs/*` (see [scripts/setup-deploy-role.ts](../scripts/setup-deploy-role.ts) for the deploy role's grant of this).

When `web/e2e-config.json` exists, [playwright.config.ts](../web/playwright.config.ts) points `baseURL` at the deployed CloudFront URL (`https://<domain>/<branch>/`) and skips starting a local dev server. [auth.setup.ts](../web/e2e/auth.setup.ts) reads Cognito pool info from the same file; `amplify_outputs.json` is no longer required for e2e tests.

Delete `web/e2e-config.json` (or don't create it) to fall back to the local dev-server flow described above.

## Authentication

Authentication runs once as a setup project before any tests execute.
The setup lives in [web/e2e/auth.setup.ts](../web/e2e/auth.setup.ts) and produces `.auth/user.json` (gitignored).

The test user is provisioned at deploy time via a CDK custom resource (`web/amplify/constructs/e2eTestUser/`). It stores the user's email and password in SSM Parameter Store. The e2e setup script reads those parameters (paths are included in `web/e2e-config.json`) and signs in via `InitiateAuthCommand` — it needs only `ssm:GetParameter`, not any Cognito admin permission.


This means the AWS credentials running the test suite never need `cognito-idp:AdminCreateUser` — that permission is scoped to the custom resource's own Lambda role at deploy time. Re-running `pnpm run deploy` rotates the test user's password (the custom resource runs `AdminSetUserPassword` on every Update).

After a successful login the session is cached in `web/.auth/user.json`. All subsequent test projects load this file via `storageState` and never re-authenticate unless the file is deleted or the session expires.

To force a fresh login, delete `.auth/user.json` and re-run.

## Config overview

[web/playwright.config.ts](../web/playwright.config.ts) defines two projects:

| Project | Purpose |
|---|---|
| `setup` | Runs `auth.setup.ts` once; creates `.auth/user.json` |
| `chromium` | Runs all `*.spec.ts` files; depends on `setup` |

`workers` is set to `1` — tests run serially. The chat agent has shared session state (session ID from `localStorage`), so parallel workers would create race conditions between tests that read/write the same chat history.

## Writing tests

### File structure

```
web/e2e/
  auth.setup.ts   ← do not rename; matched by playwright.config.ts
  chat.spec.ts    ← one file per feature area
  <feature>.spec.ts
```

Group related assertions with `test.describe`. One page = one file is a good default.

### Selectors

Prefer stable selectors in this order:

1. `data-testid` — add these to components when no semantic selector works
2. ARIA role + accessible name: `page.getByRole('button', { name: 'Submit' })`
3. Label text: `page.getByLabel('Email')`
4. Placeholder: `page.getByPlaceholder('Type a message…')`

Avoid CSS class selectors — they change with refactors. The `is-user` / `is-assistant` classes on `Message` are internal layout classes; use `[data-testid="message-user"]` and `[data-testid="message-assistant"]` instead.

### Navigation

Use `page.goto('agents')`, not `page.goto('/agents')`. `baseURL` for a remote deployment includes a branch path prefix (`https://<domain>/<branch>/`); a leading slash resolves against the origin and drops that prefix.

### Timeouts

The agent response can take up to ~60 seconds on a cold start. Use an explicit `timeout` on any assertion that waits for an assistant reply:

```ts
await expect(page.locator('[data-testid="message-assistant"]').last()).toBeVisible({
  timeout: 60_000,
});
```

The global default timeout (5 s) is intentionally kept short for fast failures on non-agent assertions.

### Example: chat round-trip

```ts
import { test, expect } from '@playwright/test';

test('agent responds to a greeting', async ({ page }) => {
  await page.goto('chat');

  const textarea = page.getByRole('textbox', { name: 'message' });
  await textarea.fill('Say exactly: hello');
  await textarea.press('Enter');

  await expect(page.locator('[data-testid="message-assistant"]').last()).toBeVisible({
    timeout: 60_000,
  });
});
```

### Example: asserting specific response content

```ts
test('agent echoes the user message', async ({ page }) => {
  await page.goto('chat');

  await page.getByRole('textbox', { name: 'message' }).fill('What is 2 + 2?');
  await page.getByRole('button', { name: 'Submit' }).click();

  // Wait for streaming to finish
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible({ timeout: 60_000 });

  const lastReply = page.locator('[data-testid="message-assistant"]').last();
  await expect(lastReply).toContainText('4');
});
```

## Harness webhook pipeline test (live, opt-in)

[`web/e2e/webhook-stepfunction.spec.ts`](../web/e2e/webhook-stepfunction.spec.ts) verifies the AgentCore harness end-to-end (issue [#50](https://github.com/waltmayf/agents4energy/issues/50)). Rather than faking a GitHub webhook delivery, it starts the deployed **Step Function** directly with the same input shape `agent-webhook-receiver` produces, waits for the execution to `SUCCEEDED`, and asserts the final harness text carries no leaked Harmony tokens (`<|channel|>` etc., [#105](https://github.com/waltmayf/agents4energy/issues/105)). Because the run survives to completion, it also exercises the transient-424 retry hardening ([#123](https://github.com/waltmayf/agents4energy/issues/123)).

This test runs a **real harness turn** (minutes of Bedrock time) and **posts real comments** to a GitHub issue, so it's opt-in:

```bash
cd web
RUN_WEBHOOK_E2E=1 pnpm test:e2e e2e/webhook-stepfunction.spec.ts
```

- It's skipped unless `RUN_WEBHOOK_E2E=1`, and also skipped if `agentWebhookStateMachineArn` is missing from `web/e2e-config.json` (redeploy the backend to publish it).
- Target issue defaults to `waltmayf/agents4energy` #50; override with `WEBHOOK_E2E_REPO` / `WEBHOOK_E2E_ISSUE`.
- The prompt is deliberately read-only (asks the agent to report, not to open a PR), so the test is idempotent. It uses the `comment` trigger, so it also exercises the comment-run label bookkeeping ([#77](https://github.com/waltmayf/agents4energy/issues/77)).
- No browser/auth is needed — it talks to Step Functions via the AWS SDK, so only AWS credentials with `states:StartExecution`/`states:DescribeExecution` are required.

## PR checks gate

Every pull request runs a fast, credential-free gate (`.github/workflows/checks.yml`, issue #135) that blocks merge when the code doesn't type-check or the unit tests fail:

- `cd web && npx tsc --noEmit`
- `cd web && pnpm test:unit`

It does **not** deploy or touch AWS — it exists to catch the class of defect that shipped in PR #134 (a non-compiling `backend.ts` that no CI step flagged). Reproduce it locally with those two commands. Lint (`pnpm lint`) is not gated yet — `main` has a pre-existing eslint backlog to clear first.

> Like all workflows here, the source of truth is `.github/workflow-drafts/checks.yml`; a maintainer copies it to `.github/workflows/` (see CLAUDE.md).

## CI

On CI set `CI=true`. This enables:
- 1 retry per failed test (flake tolerance)
- `forbidOnly` — `test.only` left in source causes a hard failure

If `web/e2e-config.json` is absent, the `webServer` block in `playwright.config.ts` spins up `pnpm dev` and waits up to 2 minutes for `https://localhost:3000` to be ready. If present, no server is started — tests run directly against the deployed CloudFront URL. Either way, AWS credentials must be available for the auth setup to read the test user's SSM parameters and sign in.

## Debugging

```bash
# Run with Playwright inspector (pauses at each action)
PWDEBUG=1 pnpm test:e2e

# Save a trace and open it
pnpm test:e2e --trace on
npx playwright show-trace test-results/<run>/trace.zip
```

HTML report is written to `playwright-report/` after every run. Open with:

```bash
npx playwright show-report
```
