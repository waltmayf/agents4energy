#!/usr/bin/env tsx
// Interactive / one-shot chat with the deployed AgentCore harness — WITH agent
// config injected the same way the frontend does (system prompt + MCP tools
// routed through the gateway). Unlike scripts/invoke.ts (which sends a bare
// prompt and no tools), this lets you exercise gateway-backed MCP features like
// the Knowledge Graph tools from the CLI.
//
// Usage:
//   npx tsx scripts/chat.ts "Your prompt"                 # one-shot, default agent (no tools)
//   npx tsx scripts/chat.ts --kg "Add well W-1 to the graph and traverse from it"
//   npx tsx scripts/chat.ts --server "Knowledge Graph Tools" "…"   # attach a named McpServer
//   npx tsx scripts/chat.ts --session <id> "…"            # continue an existing session
//   npx tsx scripts/chat.ts -i --kg                       # interactive REPL (KG tools attached)
//
// Auth: reads TEST_USER_EMAIL / TEST_USER_PASSWORD from scripts/.env.local.
// The harness authorizes InvokeHarness via SigV4 (Identity Pool creds), while
// each gateway-routed MCP tool carries the caller's Cognito ACCESS token as
// `Authorization: Bearer` — the gateway's CUSTOM_JWT authorizer rejects an ID
// token with insufficient_scope (#327). Mirrors web/lib/harness-agent.ts.
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { fromCognitoIdentityPool, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- CLI args -------------------------------------------------------------
const argv = process.argv.slice(2);
let interactive = false;
let attachKg = false;
let rawGateway = false;
let useIamInvoke = false;
let sessionId = '';
const serverNames: string[] = [];
const promptParts: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-i' || a === '--interactive') interactive = true;
  else if (a === '--kg') attachKg = true;
  // Attach the gateway endpoint directly (exposes ALL registered targets' tools)
  // WITHOUT requiring a matching McpServer record with a gatewayTargetId. Useful
  // for probing gateway tools whose McpServer row hasn't been wired up yet.
  else if (a === '--gateway') rawGateway = true;
  else if (a === '--server') serverNames.push(argv[++i]);
  else if (a === '--session') sessionId = argv[++i];
  // Sign InvokeHarness with your local AWS profile (fromNodeProviderChain)
  // instead of the test user's Identity-Pool creds. Needed while grouped users
  // lack the InvokeHarness grant (#360); the gateway MCP tools still carry the
  // test user's Cognito access token.
  else if (a === '--iam') useIamInvoke = true;
  else promptParts.push(a);
}
if (attachKg) serverNames.push('Knowledge Graph Tools');
sessionId ||= randomUUID();

// ---- Config ---------------------------------------------------------------
const amplifyOutputs = JSON.parse(readFileSync(resolve(root, 'web/amplify_outputs.json'), 'utf8'));
const {
  user_pool_id: userPoolId,
  user_pool_client_id: clientId,
  identity_pool_id: identityPoolId,
  aws_region: authRegion,
} = amplifyOutputs.auth;
const harnessArn: string = amplifyOutputs.custom?.agentcore_harness_arn;
const gatewayEndpoint: string = amplifyOutputs.custom?.agentcore_gateway_endpoint;
if (!harnessArn) {
  console.error('No harness ARN in web/amplify_outputs.json — run `pnpm deploy` first');
  process.exit(1);
}
const region = harnessArn.split(':')[3];

// ---- Test-user credentials -----------------------------------------------
// Prefer SSM (the source of truth the e2e suite / auth.setup.ts use), so this
// keeps working after the test user's password rotates. Fall back to
// scripts/.env.local for a hand-provisioned user.
async function loadCredentials(): Promise<{ email: string; password: string }> {
  const emailPath = amplifyOutputs.custom?.e2e_test_user_email_ssm_path;
  const passwordPath = amplifyOutputs.custom?.e2e_test_user_password_ssm_path;
  if (emailPath && passwordPath) {
    const ssm = new SSMClient({ region: authRegion });
    const [e, p] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: emailPath })),
      ssm.send(new GetParameterCommand({ Name: passwordPath, WithDecryption: true })),
    ]);
    const email = e.Parameter?.Value;
    const password = p.Parameter?.Value;
    if (email && password) return { email, password };
  }
  try {
    const env = Object.fromEntries(
      readFileSync(resolve(root, 'scripts/.env.local'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => {
          const idx = l.indexOf('=');
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        }),
    );
    if (env.TEST_USER_EMAIL && env.TEST_USER_PASSWORD) {
      return { email: env.TEST_USER_EMAIL, password: env.TEST_USER_PASSWORD };
    }
  } catch {
    /* no .env.local — fall through */
  }
  console.error('No credentials: set custom.e2e_test_user_*_ssm_path in amplify_outputs.json or TEST_USER_* in scripts/.env.local');
  process.exit(1);
}
const { email, password } = await loadCredentials();

// ---- Authenticate: ID token (→ Identity Pool creds) + ACCESS token (gateway) ----
const cognito = new CognitoIdentityProviderClient({ region: authRegion });
const authResult = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }),
);
const idToken = authResult.AuthenticationResult?.IdToken;
const accessToken = authResult.AuthenticationResult?.AccessToken;
if (!idToken || !accessToken) {
  console.error('Authentication failed — missing ID or ACCESS token');
  process.exit(1);
}
const credentials = fromCognitoIdentityPool({
  clientConfig: { region: authRegion },
  identityPoolId,
  logins: { [`cognito-idp.${authRegion}.amazonaws.com/${userPoolId}`]: idToken },
});

// ---- Resolve MCP servers → gateway-routed remote_mcp tools ---------------
type McpServerRow = { id: string; name: string; gatewayTargetId: string | null };
async function resolveTools(): Promise<any[] | undefined> {
  if (rawGateway) {
    console.error(`✓ Attached gateway endpoint directly (all registered targets)`);
    return [
      {
        type: 'remote_mcp',
        name: 'gateway',
        config: { remoteMcp: { url: gatewayEndpoint, headers: { Authorization: `Bearer ${accessToken}` } } },
      },
    ];
  }
  if (serverNames.length === 0) return undefined;
  // Resolve the requested servers + their gateway target ids via the existing
  // SigV4 GraphQL runner (scripts/graphql.sh signs with your local AWS creds).
  const { execFileSync } = await import('child_process');
  const out = execFileSync(
    resolve(root, 'scripts/graphql.sh'),
    ['query { listMcpServers(limit: 100) { items { id name gatewayTargetId } } }'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out) as { data?: { listMcpServers: { items: McpServerRow[] } }; errors?: unknown };
  if (parsed.errors) throw new Error(`listMcpServers failed: ${JSON.stringify(parsed.errors)}`);
  const all = parsed.data!.listMcpServers.items;

  const tools: any[] = [];
  for (const name of serverNames) {
    const row = all.find((s) => s.name === name);
    if (!row) {
      console.error(`⚠️  No McpServer named "${name}" found. Available: ${all.map((s) => s.name).join(', ')}`);
      continue;
    }
    if (!row.gatewayTargetId) {
      console.error(
        `⚠️  McpServer "${name}" has no gatewayTargetId — the frontend (buildTools) would SKIP it, so it is not reachable. Register it as a gateway target first.`,
      );
      continue;
    }
    tools.push({
      type: 'remote_mcp',
      name: row.name,
      config: { remoteMcp: { url: gatewayEndpoint, headers: { Authorization: `Bearer ${accessToken}` } } },
    });
    console.error(`✓ Attached "${name}" (gatewayTargetId=${row.gatewayTargetId}) via gateway`);
  }
  return tools.length ? tools : undefined;
}

const tools = await resolveTools();
// InvokeHarness is authorized either with the test user's Identity-Pool creds
// (default) or your local AWS profile (--iam). The gateway MCP tools always
// carry the test user's Cognito ACCESS token regardless.
const invokeCredentials = useIamInvoke ? fromNodeProviderChain() : credentials;
const agentCore = new BedrockAgentCoreClient({ region, credentials: invokeCredentials });

async function send(text: string): Promise<void> {
  const response = await agentCore.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: sessionId,
      messages: [{ role: 'user', content: [{ text }] }],
      tools,
    }),
  );
  for await (const event of response.stream ?? []) {
    if (event.validationException || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
      console.error(`\n⚠️  Harness stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
      return;
    }
    // Surface tool activity so we can see the KG tools actually fire.
    const tu = event.contentBlockStart?.start?.toolUse;
    if (tu) process.stdout.write(`\n[tool: ${tu.name}] `);
    const delta = event.contentBlockDelta?.delta;
    if (delta?.text) process.stdout.write(delta.text);
    if (delta?.toolUse?.input) process.stdout.write(delta.toolUse.input);
  }
  process.stdout.write('\n');
}

console.error(`session: ${sessionId}\n`);

if (interactive) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/exit' || text === '/quit') break;
    await send(text);
    rl.prompt();
  }
  rl.close();
} else {
  const text = promptParts.join(' ') || 'Hello!';
  console.error(`> ${text}\n`);
  await send(text);
}
