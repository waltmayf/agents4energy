# Branch Teardown

## What's Branch-Scoped

Each branch that runs `pnpm deploy` (`scripts/build.sh`) creates a single branch-scoped stack:

| Stack | Resources | Identifier |
|---|---|---|
| Amplify sandbox root stack | Cognito, AppSync, Lambda, DynamoDB, plus nested `hosting` stack (S3 + CloudFront) | `amplify-web-<slug>-sandbox-<hash>`, deployed with `--identifier <slug>` |

Hosting (S3 + CloudFront) and the AgentCore harness/memory are both **nested stacks** inside the sandbox root stack (`backend.createStack('hosting')` / `backend.createStack('agent')` in `web/amplify/backend.ts`), not separately deployed CDK apps — deleting the root stack tears down everything, including the harness and memory. The hosting bucket has `autoDeleteObjects: true` (`web/amplify/constructs/hostingConstruct.ts`), so CloudFormation empties it automatically; no manual `aws s3 rm` is needed before deletion.

Since the harness/memory spec (`harnessSpecs`/`memorySpecs` in `backend.ts`) is unique-named per branch/sandbox (see `uniqueProjectName`), every branch gets its **own** harness + memory — there is no shared "default" AgentCore project anymore. Deleting a branch's stack deletes that branch's harness and memory along with it, same as hosting.

## Deleting a Branch's Stack

`.github/workflows-drafts/delete-branch-stack.yml` is a draft workflow that runs on the `delete` event (branch deletion) and tears down the branch-scoped stack above:

1. Resolves the branch slug the same way `scripts/build.sh` does (slashes → dashes, lowercase, truncate to 14 chars, then strip hyphens — matching how `ampx` names the sandbox stack)
2. Looks up the sandbox root stack name via `aws cloudformation list-stacks` (no CDK build/synth needed)
3. Fires `aws cloudformation delete-stack` and returns immediately — it does not wait for the delete to finish

It's kept in `workflows-drafts/` rather than `.github/workflows/` because the Claude GitHub App can't write directly to `.github/workflows/` — copy it over manually to enable it:

```bash
cp .github/workflows-drafts/delete-branch-stack.yml .github/workflows/delete-branch-stack.yml
```

It reuses the same `AWS_ROLE_ARN` secret and `AWS_REGION` variable as `deploy.yml`, and can also be triggered manually via `workflow_dispatch` (pass the branch name) to clean up a stack whose branch was already deleted before this workflow existed.

Note: GitHub only fires `delete` events for workflow files that exist on the repository's default branch, so this workflow has no effect until it's merged there.
