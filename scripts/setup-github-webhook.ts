#!/usr/bin/env tsx
/**
 * Register (or update) the GitHub repository webhook that drives the
 * API Gateway → Step Function → AgentCore Harness pipeline (see issue #35 and
 * docs/webhook-stepfunction-integration.md).
 *
 * This is the webhook counterpart to scripts/setup-github-integration.ts (which
 * wires the *Actions*-based @agent-<slug> flow). Run it once after a deploy that
 * provisions the webhook stack — it is fully idempotent, so re-running it just
 * updates the existing hook in place.
 *
 * Usage:
 *   npx tsx scripts/setup-github-webhook.ts --repo owner/name
 *   npx tsx scripts/setup-github-webhook.ts --repo owner/name \
 *     --outputs web/amplify_outputs.json \
 *     --secret-arn arn:aws:secretsmanager:...:secret:agents4energy/github-webhook-secret-XXXX
 *
 * What it does:
 *   1. Reads `custom.agent_webhook_url` from web/amplify_outputs.json (written by
 *      `ampx sandbox` / `pnpm deploy`).
 *   2. Reads the webhook HMAC secret from Secrets Manager. The ARN is taken from
 *      --secret-arn, else $GITHUB_WEBHOOK_SECRET_ARN, else the receiver Lambda's
 *      GITHUB_WEBHOOK_SECRET_ARN env var (discovered from the same sandbox) so
 *      the value registered on GitHub is guaranteed to match what the deployed
 *      receiver verifies against.
 *   3. Creates the repo webhook (event: issue_comment, content-type: json,
 *      secret: the HMAC value) — or, if a hook with the same payload URL already
 *      exists, updates it in place. Never creates a duplicate.
 *
 * Prerequisites:
 *   gh CLI authenticated with a token that has admin:repo_hook (the `repo`
 *     scope covers it) — `gh auth login`.
 *   AWS CLI configured for the deployment account.
 *   A deploy that provisioned the webhook stack (agent_webhook_url present in
 *     amplify_outputs.json).
 *
 * Mention the agent with `@webhook-agent <request>` on an issue/PR comment to
 * trigger it.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function argFlag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function aws(cmd: string): string {
  return execSync(`aws ${cmd}`, { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function gh(args: string[]): string {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function ghJson<T = unknown>(args: string[]): T {
  return JSON.parse(gh(args) || 'null');
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

let repo = argFlag('--repo') ?? '';
repo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
if (!repo) fail('--repo <owner/name> is required.');

const outputsPath = resolve(root, argFlag('--outputs') ?? 'web/amplify_outputs.json');
if (!existsSync(outputsPath)) {
  fail(`${outputsPath} not found. Run a deploy first (pnpm deploy / ampx sandbox).`);
}
const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'));

const webhookUrl: string = outputs.custom?.agent_webhook_url ?? '';
if (!webhookUrl) {
  fail('custom.agent_webhook_url missing from amplify_outputs.json — the deploy did not provision the webhook stack.');
}

const region: string = outputs.custom?.agentcore_region ?? process.env.AWS_REGION ?? 'us-east-1';

// ─── Check gh auth ─────────────────────────────────────────────────────────────

try {
  gh(['auth', 'status']);
} catch {
  fail('gh CLI is not authenticated. Run `gh auth login` (needs admin:repo_hook, covered by the `repo` scope).');
}

// ─── Resolve the webhook HMAC secret ARN ──────────────────────────────────────
// Prefer the value the deployed receiver Lambda actually verifies against, so
// the secret registered on GitHub can never drift from the backend.

function findReceiverSecretArn(): string | undefined {
  try {
    const fns = JSON.parse(
      aws(
        `lambda list-functions --region ${region} ` +
        `--query "Functions[?contains(FunctionName,'ebhookrecei')].FunctionName" --output json`,
      ),
    ) as string[];
    for (const name of fns) {
      const env = JSON.parse(
        aws(
          `lambda get-function-configuration --region ${region} ` +
          `--function-name ${name} --query "Environment.Variables" --output json`,
        ),
      ) as Record<string, string>;
      if (env?.GITHUB_WEBHOOK_SECRET_ARN) return env.GITHUB_WEBHOOK_SECRET_ARN;
    }
  } catch { /* fall through */ }
  return undefined;
}

const secretArn =
  argFlag('--secret-arn') ??
  process.env.GITHUB_WEBHOOK_SECRET_ARN ??
  findReceiverSecretArn();

if (!secretArn) {
  fail(
    'Could not determine the webhook secret ARN. Pass --secret-arn, set ' +
    '$GITHUB_WEBHOOK_SECRET_ARN, or ensure the receiver Lambda was deployed ' +
    'with GITHUB_WEBHOOK_SECRET_ARN set.',
  );
}

let secretValue: string;
try {
  secretValue = aws(
    `secretsmanager get-secret-value --region ${region} ` +
    `--secret-id ${secretArn} --query SecretString --output text`,
  );
} catch (e) {
  fail(`Failed to read the webhook secret from ${secretArn}: ${(e as Error).message}`);
}
if (!secretValue || secretValue === 'None') {
  fail(`Secret ${secretArn} has no SecretString value.`);
}

console.log(`Repository:  ${repo}`);
console.log(`Webhook URL: ${webhookUrl}`);
console.log(`Secret ARN:  ${secretArn}`);
console.log(`Region:      ${region}\n`);

// ─── Create or update the hook (idempotent) ────────────────────────────────────

interface Hook { id: number; config: { url?: string }; events: string[] }

const hooks = ghJson<Hook[]>(['api', `repos/${repo}/hooks`, '--paginate']) ?? [];
const existing = hooks.find((h) => h.config?.url === webhookUrl);

const configFields = [
  '-f', `config[url]=${webhookUrl}`,
  '-f', 'config[content_type]=json',
  '-f', `config[secret]=${secretValue}`,
  '-f', 'config[insecure_ssl]=0',
];

// issue_comment → `@webhook-agent` mention; issues/pull_request → `agentcore`
// label trigger (issue #56). All three route to the same receiver Lambda.
const eventFields = [
  '-f', 'events[]=issue_comment',
  '-f', 'events[]=issues',
  '-f', 'events[]=pull_request',
];

if (existing) {
  gh([
    'api', '-X', 'PATCH', `repos/${repo}/hooks/${existing.id}`,
    '-F', 'active=true',
    ...eventFields,
    ...configFields,
  ]);
  console.log(`✓ Updated existing webhook (id ${existing.id}) — issue_comment/issues/pull_request events, secret refreshed.`);
} else {
  const created = ghJson<{ id: number }>([
    'api', '-X', 'POST', `repos/${repo}/hooks`,
    '-f', 'name=web',
    '-F', 'active=true',
    ...eventFields,
    ...configFields,
  ]);
  console.log(`✓ Created webhook (id ${created.id}) — issue_comment/issues/pull_request events.`);
}

// ─── Verify the ping delivered ─────────────────────────────────────────────────
// GitHub sends a `ping` on create; a fresh PATCH does not re-ping, so only
// report delivery status when we can see a recent one.

try {
  const hookId = existing?.id ?? ghJson<Hook[]>(['api', `repos/${repo}/hooks`])
    .find((h) => h.config?.url === webhookUrl)?.id;
  if (hookId) {
    const deliveries = ghJson<Array<{ event: string; status_code: number }>>([
      'api', `repos/${repo}/hooks/${hookId}/deliveries`,
    ]) ?? [];
    const ping = deliveries.find((d) => d.event === 'ping');
    if (ping) console.log(`  ping delivery: HTTP ${ping.status_code}`);
  }
} catch { /* delivery listing is best-effort */ }

console.log(`
${'─'.repeat(72)}
Webhook configured for ${repo}.

Trigger the API Gateway → Step Function → AgentCore Harness pipeline by either:
  • commenting "@webhook-agent <your request>" on any issue or PR, or
  • applying the "agentcore" label to an issue or PR.
See docs/webhook-stepfunction-integration.md.
${'─'.repeat(72)}
`);
