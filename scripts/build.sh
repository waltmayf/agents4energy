#!/usr/bin/env bash
set -euo pipefail

# Full build + deploy pipeline (single command):
#   1. Deploy everything via npx ampx sandbox --once (Amplify + hosting + agent stacks)
#   2. Build the Next.js frontend
#   3. Upload to S3 and invalidate CloudFront cache
#
# The AgentCore harness/memory/gateway are built directly inside the
# agentStack CDK app (see web/amplify/backend.ts) and their ARNs land in
# amplify_outputs.json via backend.addOutput({ custom: {...} }) — no
# post-deploy wiring script is needed.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Derive branch from git or DEPLOY_BRANCH env var
BRANCH="${DEPLOY_BRANCH:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}"
# Normalise: replace slashes with dashes, lowercase, truncate to 14 chars (ampx --identifier limit is 15)
export BRANCH_SLUG="$(echo "$BRANCH" | tr '/' '-' | tr '[:upper:]' '[:lower:]' | cut -c1-14)"

echo "Branch:      $BRANCH"
echo "Branch slug: $BRANCH_SLUG"
echo ""

# ── 0. Register QEMU ARM64 binfmt (needed to build ARM64 Docker images on AMD64 runners) ─
# Runs inside build.sh so it doesn't need a separate allowed tool entry.
if docker info --format '{{.Architecture}}' 2>/dev/null | grep -q 'x86_64\|amd64'; then
  echo "AMD64 runner detected — setting up QEMU ARM64 binfmt…"
  docker run --rm --privileged tonistiigi/binfmt --install arm64 2>/dev/null || true
fi

# ── 1. Deploy everything with a single ampx sandbox --once ───────────────────
echo "Deploying Amplify sandbox (including hosting + agent stacks)…"
(cd "$REPO_ROOT/web" && npx ampx sandbox --once --identifier "$BRANCH_SLUG")

# ── 1b. Publish e2e config to SSM (read by scripts/fetch-e2e-config.ts) ──────
# This param used to be a CDK-owned aws_ssm.StringParameter with a fixed name.
# If a deploy that first created it later rolled back for an unrelated reason,
# CloudFormation could leave it orphaned (exists in Parameter Store, owned by
# no stack) — every subsequent deploy's CREATE of that resource then failed
# with AlreadyExists, permanently wedging the pipeline (issue #192). Writing it
# here with `--overwrite` instead is idempotent and self-heals after a
# rollback: the param is derived fresh from this run's own stack outputs and
# just gets overwritten, no CFN ownership involved.
#
# Gated on GITHUB_REPOSITORY (set automatically in GitHub Actions) so a local
# `pnpm deploy` doesn't publish a param at a path scripts/fetch-e2e-config.ts
# (which requires GITHUB_REPOSITORY or a git remote to derive the repo slug)
# wouldn't derive the same way.
#
# Slug rules must match scripts/fetch-e2e-config.ts's slugRepo/slugBranch
# exactly: repoSlug = lowercased "owner/repo" with non [a-z0-9-/] chars
# replaced by '-'; branchSlug = $BRANCH_SLUG above (already lowercased +
# truncated to 14 chars, the same value passed to `ampx sandbox --identifier`).
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  # `-` MUST be last in the bracket class — sed reads `9-/` as a character
  # range (invalid: '/' < '9') and aborts with "Invalid range end". Use `#` as
  # the s/// delimiter so the literal '/' in the class isn't taken as the
  # delimiter. Matches fetch-e2e-config.ts's /[^a-z0-9-/]+/ (JS is lenient
  # about a mid-class dash; sed is not).
  E2E_CONFIG_REPO_SLUG="$(echo "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9/-]+#-#g')"
  E2E_CONFIG_SSM_PATH="/outputs/$E2E_CONFIG_REPO_SLUG/$BRANCH_SLUG/e2e-config"

  echo "Publishing e2e config to SSM: $E2E_CONFIG_SSM_PATH…"
  E2E_CONFIG_VALUE=$(node -e "
    const o = JSON.parse(require('fs').readFileSync('$REPO_ROOT/web/amplify_outputs.json', 'utf8'));
    const c = o.custom ?? {};
    console.log(JSON.stringify({
      appUrl: \`https://\${c.hosting_domain}/$BRANCH_SLUG/\`,
      userPoolId: o.auth.user_pool_id,
      userPoolClientId: o.auth.user_pool_client_id,
      region: c.agentcore_region,
      testUserEmailSsmPath: c.e2e_test_user_email_ssm_path,
      testUserPasswordSsmPath: c.e2e_test_user_password_ssm_path,
      agentWebhookStateMachineArn: c.agent_webhook_state_machine_arn,
      // AppSync endpoint so the e2e suite can purge/tear-down its McpServer
      // records directly via SigV4-signed GraphQL (issue #308) instead of the
      // UI — an API delete can't be skipped by a timed-out UI assertion.
      graphqlUrl: o.data.url,
    }));
  ")
  aws ssm put-parameter --name "$E2E_CONFIG_SSM_PATH" --type String --overwrite --value "$E2E_CONFIG_VALUE"

  # ── 1c. Publish the ActiveRun GraphQL endpoint to SSM (issue #15) ──────────
  # The ClaudeCode AgentCore runtime writes its own ActiveRun snapshots straight
  # to AppSync via SigV4 (see agent/default/app/ClaudeCode/server.js) instead of
  # through a Lambda auth adapter, so it needs the GraphQL URL + region at
  # startup. Can't be a CDK env var built from a data-stack token (that would
  # reintroduce the data->agent stack cycle backend.ts's runtime wiring
  # deliberately avoids) — so, same as the e2e config above, publish it here
  # from this run's own amplify_outputs.json with --overwrite (idempotent,
  # self-healing, no CFN ownership involved). The runtime is granted
  # ssm:GetParameter on /outputs/* in backend.ts to read it back.
  ACTIVERUN_SSM_PATH="/outputs/$E2E_CONFIG_REPO_SLUG/$BRANCH_SLUG/activerun-graphql"
  echo "Publishing ActiveRun GraphQL config to SSM: $ACTIVERUN_SSM_PATH…"
  ACTIVERUN_SSM_VALUE=$(node -e "
    const o = JSON.parse(require('fs').readFileSync('$REPO_ROOT/web/amplify_outputs.json', 'utf8'));
    console.log(JSON.stringify({ url: o.data.url, region: o.data.aws_region }));
  ")
  aws ssm put-parameter --name "$ACTIVERUN_SSM_PATH" --type String --overwrite --value "$ACTIVERUN_SSM_VALUE"
else
  echo "GITHUB_REPOSITORY not set — skipping e2e config publish (local pnpm deploy)"
fi

# ── 2. Build the Next.js frontend ─────────────────────────────────────────────
# NEXT_BASE_PATH must match the S3 upload prefix below so the static export's
# asset/route URLs (and the root page's redirect to /chat) resolve correctly
# once served from https://<domain>/<branch-slug>/.
echo "Building Next.js app…"
NEXT_BASE_PATH="/$BRANCH_SLUG" NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter web build

# ── 3. Upload to S3 and invalidate CloudFront ────────────────────────────────
AMPLIFY_OUTPUTS="$REPO_ROOT/web/amplify_outputs.json"

if [ ! -f "$AMPLIFY_OUTPUTS" ]; then
  echo "Error: amplify_outputs.json not found at $AMPLIFY_OUTPUTS"
  exit 1
fi

BUCKET=$(node -p "JSON.parse(require('fs').readFileSync('$AMPLIFY_OUTPUTS','utf8')).custom?.hosting_bucket_name ?? ''")
DIST_ID=$(node -p "JSON.parse(require('fs').readFileSync('$AMPLIFY_OUTPUTS','utf8')).custom?.hosting_distribution_id ?? ''")
DOMAIN=$(node -p "JSON.parse(require('fs').readFileSync('$AMPLIFY_OUTPUTS','utf8')).custom?.hosting_domain ?? ''")

if [ -z "$BUCKET" ] || [ -z "$DIST_ID" ]; then
  echo "Error: hosting_bucket_name or hosting_distribution_id missing from amplify_outputs.json"
  exit 1
fi

echo "Uploading to S3 bucket: $BUCKET (prefix: $BRANCH_SLUG)…"
aws s3 sync "$REPO_ROOT/web/out/" "s3://$BUCKET/$BRANCH_SLUG/" --delete

echo "Invalidating CloudFront distribution: $DIST_ID…"
AWS_PAGER="" aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" --paths "/$BRANCH_SLUG/*"

echo ""
echo "Deployed: https://$DOMAIN/$BRANCH_SLUG/"
