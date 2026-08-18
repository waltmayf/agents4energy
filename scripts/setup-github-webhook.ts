#!/usr/bin/env tsx
/**
 * Register (or update) the GitHub repository webhook that drives the
 * API Gateway → Step Function → AgentCore Harness pipeline (see issue #35 and
 * docs/webhook-stepfunction-integration.md).
 *
 * Run it once after a deploy that provisions the webhook stack — it is fully
 * idempotent, so re-running it just updates the existing hook in place.
 *
 * Usage:
 *   npx tsx scripts/setup-github-webhook.ts --repo owner/name
 *   npx tsx scripts/setup-github-webhook.ts --repo owner/name \
 *     --outputs web/amplify_outputs.json \
 *     --secret <hmac-value>   # or legacy: --secret-arn arn:...:secret:...
 *
 * What it does:
 *   1. Reads `custom.agent_webhook_url` from web/amplify_outputs.json (written by
 *      `ampx sandbox` / `pnpm deploy`), and resolves the receiver Lambda that
 *      backs it by looking up the API Gateway (HTTP API) integration for that
 *      URL's API id — this picks the exact receiver for *this* sandbox, not
 *      just the first Lambda whose name happens to contain "webhookreceiver"
 *      (see "Multiple sandboxes" below). Falls back to a `list-functions`
 *      name-contains match if the API Gateway lookup fails.
 *   2. Resolves the webhook HMAC secret value. Preference order:
 *        a. --secret <value> (explicit),
 *        b. if the receiver Lambda carries an `AMPLIFY_SSM_ENV_CONFIG` env var
 *           for `GITHUB_WEBHOOK_SECRET` — i.e. Amplify resolves the secret()
 *           from SSM at cold start rather than baking the value into the
 *           Lambda's static env — read the real value straight from SSM
 *           Parameter Store (`ssm get-parameter --with-decryption`), trying
 *           the sandbox-specific `path` first, then the shared `sharedPath`
 *           (issue #446: the static env var is only a placeholder in this
 *           case, and registering it on GitHub causes a 401 on every real
 *           delivery even though the `ping` looks like it succeeded),
 *        c. otherwise, the receiver Lambda's static GITHUB_WEBHOOK_SECRET env
 *           var value — the resolved value Amplify's secret() baked in
 *           directly (issue #239), so what we register on GitHub can't drift
 *           from what the receiver verifies,
 *        d. --secret-arn / $GITHUB_WEBHOOK_SECRET_ARN → Secrets Manager
 *           (legacy fallback for backends predating the secret() migration).
 *   3. Creates the repo webhook (event: issue_comment, content-type: json,
 *      secret: the HMAC value) — or, if a hook with the same payload URL already
 *      exists, updates it in place. Never creates a duplicate.
 *
 * Multiple sandboxes in one AWS account:
 *   Every personal `ampx sandbox` deploy provisions its own receiver Lambda
 *   (name suffixed with a per-sandbox hash), so `lambda list-functions
 *   --query "contains(FunctionName,'ebhookrecei')"` can match more than one
 *   function across an account with several active sandboxes — picking the
 *   wrong one silently registers a secret (or, pre-#446, a placeholder) that
 *   the intended sandbox's receiver never sees. Resolving the receiver via the
 *   `agent_webhook_url`'s own API Gateway integration avoids the ambiguity
 *   entirely, since that URL is specific to the sandbox in amplify_outputs.json.
 *
 * Prerequisites:
 *   gh CLI authenticated with a token that has admin:repo_hook (the `repo`
 *     scope covers it) — `gh auth login`.
 *   AWS CLI configured for the deployment account.
 *   A deploy that provisioned the webhook stack (agent_webhook_url present in
 *     amplify_outputs.json).
 *
 * Mention the agent with `@agentcore <request>` on an issue/PR comment to
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

// ─── Resolve the webhook HMAC secret value ─────────────────────────────────────
// Prefer the value the deployed receiver Lambda actually verifies against, so
// the secret registered on GitHub can never drift from the backend. Since the
// secret() migration (issue #239) Amplify resolves GITHUB_WEBHOOK_SECRET one of
// two ways, and we can't tell which without inspecting the function:
//   - baked directly into the Lambda's static env (older/simple deploys), or
//   - left as a placeholder in the static env, with the real value fetched
//     from SSM Parameter Store at cold start via the AMPLIFY_SSM_ENV_CONFIG
//     env var (issue #446) — registering the placeholder causes a silent 401
//     on every real delivery.
// Fall back to the legacy Secrets Manager ARN path for backends predating the
// secret() migration entirely.

// Finds the API Gateway (HTTP API) integration target Lambda for
// `webhookUrl`'s own API id, so we resolve the exact receiver for this
// sandbox rather than guessing from a name substring across the account.
function resolveReceiverFunctionNameFromApi(): string | undefined {
  const apiId = webhookUrl.match(/^https:\/\/([a-z0-9]+)\.execute-api\./i)?.[1];
  if (!apiId) return undefined;
  try {
    const integrations = JSON.parse(
      aws(`apigatewayv2 get-integrations --region ${region} --api-id ${apiId} --output json`),
    ) as { Items?: Array<{ IntegrationUri?: string }> };
    for (const item of integrations.Items ?? []) {
      const fnName = item.IntegrationUri?.match(/function:([^/:]+)/)?.[1];
      if (fnName) return fnName;
    }
  } catch { /* fall through to the list-functions fallback */ }
  return undefined;
}

function readSsmParam(name: string): string | undefined {
  try {
    const v = aws(
      `ssm get-parameter --region ${region} --name "${name}" ` +
      `--with-decryption --query Parameter.Value --output text`,
    );
    return v && v !== 'None' ? v : undefined;
  } catch {
    return undefined;
  }
}

// Reads GITHUB_WEBHOOK_SECRET straight from SSM when the receiver's
// AMPLIFY_SSM_ENV_CONFIG says the static env var is only a placeholder.
// Tries the sandbox-specific `path` first, then the shared `sharedPath`.
function resolveSsmSecret(envVars: Record<string, string>): { value: string; path: string } | undefined {
  const raw = envVars.AMPLIFY_SSM_ENV_CONFIG;
  if (!raw) return undefined;
  let config: Record<string, { path?: string; sharedPath?: string }>;
  try {
    config = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const entry = config.GITHUB_WEBHOOK_SECRET;
  if (!entry) return undefined;
  for (const path of [entry.path, entry.sharedPath]) {
    if (!path) continue;
    const value = readSsmParam(path);
    if (value) return { value, path };
  }
  return undefined;
}

function readReceiverEnv(): { value?: string; legacyArn?: string; source?: string } {
  const candidates: string[] = [];
  const apiResolved = resolveReceiverFunctionNameFromApi();
  if (apiResolved) candidates.push(apiResolved);

  try {
    const fns = JSON.parse(
      aws(
        `lambda list-functions --region ${region} ` +
        `--query "Functions[?contains(FunctionName,'ebhookrecei')].FunctionName" --output json`,
      ),
    ) as string[];
    for (const name of fns) if (!candidates.includes(name)) candidates.push(name);
  } catch { /* fall through */ }

  for (const name of candidates) {
    try {
      const env = JSON.parse(
        aws(
          `lambda get-function-configuration --region ${region} ` +
          `--function-name ${name} --query "Environment.Variables" --output json`,
        ),
      ) as Record<string, string> | null;
      if (!env) continue;

      const ssm = resolveSsmSecret(env);
      if (ssm) return { value: ssm.value, source: `SSM Parameter Store (${ssm.path}, via receiver Lambda ${name})` };

      if (env.GITHUB_WEBHOOK_SECRET) {
        return { value: env.GITHUB_WEBHOOK_SECRET, source: `receiver Lambda ${name} GITHUB_WEBHOOK_SECRET env var (static, Amplify secret)` };
      }
      if (env.GITHUB_WEBHOOK_SECRET_ARN) return { legacyArn: env.GITHUB_WEBHOOK_SECRET_ARN };
    } catch { /* try the next candidate */ }
  }
  return {};
}

function readSecretFromArn(arn: string): string {
  let v: string;
  try {
    v = aws(
      `secretsmanager get-secret-value --region ${region} ` +
      `--secret-id ${arn} --query SecretString --output text`,
    );
  } catch (e) {
    fail(`Failed to read the webhook secret from ${arn}: ${(e as Error).message}`);
  }
  if (!v || v === 'None') fail(`Secret ${arn} has no SecretString value.`);
  return v;
}

let secretValue: string;
let secretSource: string;

const explicitValue = argFlag('--secret');
const explicitArn = argFlag('--secret-arn') ?? process.env.GITHUB_WEBHOOK_SECRET_ARN;

if (explicitValue) {
  secretValue = explicitValue;
  secretSource = '--secret (explicit value)';
} else if (explicitArn) {
  secretValue = readSecretFromArn(explicitArn);
  secretSource = `Secrets Manager (${explicitArn})`;
} else {
  const receiver = readReceiverEnv();
  if (receiver.value) {
    secretValue = receiver.value;
    secretSource = receiver.source ?? 'receiver Lambda GITHUB_WEBHOOK_SECRET (Amplify secret)';
  } else if (receiver.legacyArn) {
    secretValue = readSecretFromArn(receiver.legacyArn);
    secretSource = `receiver Lambda legacy ARN (${receiver.legacyArn})`;
  } else {
    fail(
      'Could not determine the webhook secret. Pass --secret <value>, or set the ' +
      'GITHUB_WEBHOOK_SECRET Amplify secret and deploy so the receiver Lambda ' +
      'carries it (npx ampx sandbox secret set GITHUB_WEBHOOK_SECRET). Legacy: ' +
      'pass --secret-arn / set $GITHUB_WEBHOOK_SECRET_ARN.',
    );
  }
}

console.log(`Repository:  ${repo}`);
console.log(`Webhook URL: ${webhookUrl}`);
console.log(`Secret from: ${secretSource}`);
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

// issue_comment → `@agentcore` mention; issues/pull_request → `agentcore`
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
  • commenting "@agentcore <your request>" on any issue or PR, or
  • applying the "agentcore" label to an issue or PR.
See docs/webhook-stepfunction-integration.md.
${'─'.repeat(72)}
`);
