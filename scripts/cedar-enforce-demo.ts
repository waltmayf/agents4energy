#!/usr/bin/env tsx
// Cedar ENFORCE demo (#280): capture a real gateway tool DENY, then an ALLOW,
// for the same user+tool — the difference being a single GroupToolGrant row.
//
// Usage:
//   npx tsx scripts/cedar-enforce-demo.ts
//
// What it does, against the DEPLOYED default-gateway (ENFORCE mode, #280):
//   1. Authenticates the test user (TEST_USER_EMAIL / TEST_USER_PASSWORD from
//      scripts/.env.local) and reads its Cognito ACCESS token + groups.
//   2. Picks a gateway-registered McpServer (a target with a gatewayTargetId)
//      and one of its tools.
//   3. Calls that tool through the gateway /mcp endpoint (JSON-RPC tools/call)
//      with the user's Cognito JWT as Bearer — with NO matching GroupToolGrant
//      present, ENFORCE mode should return an authorization DENY.
//   4. Creates an ALLOW GroupToolGrant (group -> target.tool), waits for the
//      sync-cedar-policies Lambda (DynamoDB stream) to push the Cedar policy.
//   5. Calls the same tool again — now it should be ALLOWed.
//   6. Cleans up the grant it created and prints a captured transcript.
//
// Two gotchas this script encodes (both discovered the hard way — see #325):
//   - The gateway's CUSTOM_JWT authorizer wants the Cognito **ACCESS** token,
//     not the ID token. The ID token 403s with `insufficient_scope` at the
//     authorizer (BEFORE Cedar even runs); the access token carries
//     `scope: aws.cognito.signin.user.admin` and both carry `cognito:groups`.
//   - `tools/list` is NOT Cedar-gated per-tool (it returns HTTP 200 `{tools:[]}`
//     with or without a grant), so the authoritative DENY/ALLOW signal is a
//     real `tools/call` — which returns JSON-RPC error -32002 "Tool Execution
//     Denied … policy enforcement" when denied.
//
// This is the evidence backing docs/cedar-enforce-demo.md.
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
}

// process.env wins over scripts/.env.local, so callers can pass the authoritative
// SSM-managed E2E creds (the deploy rotates the password; .env.local can go stale):
//   TEST_USER_EMAIL=$(aws ssm get-parameter …/email …) TEST_USER_PASSWORD=$(… /password …) npx tsx scripts/cedar-enforce-demo.ts
const fileEnv = (() => { try { return parseEnv(resolve(root, 'scripts/.env.local')); } catch { return {}; } })();
const email = process.env.TEST_USER_EMAIL || fileEnv.TEST_USER_EMAIL;
const password = process.env.TEST_USER_PASSWORD || fileEnv.TEST_USER_PASSWORD;
if (!email || !password) {
  console.error('Missing TEST_USER_EMAIL / TEST_USER_PASSWORD in scripts/.env.local');
  process.exit(1);
}

const amplifyOutputs = JSON.parse(readFileSync(resolve(root, 'web/amplify_outputs.json'), 'utf8'));
const clientId: string = amplifyOutputs.auth.user_pool_client_id;
const authRegion: string = amplifyOutputs.auth.aws_region ?? 'us-east-1';
const graphqlUrl: string = amplifyOutputs.data.url;

// Optional CLI overrides: --tool <name> --server <mcpServerName>
const argv = process.argv.slice(2);
const argToolName = argFlag('--tool');
const argServerName = argFlag('--server');
function argFlag(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ── auth ───────────────────────────────────────────────────────────────────
const cognito = new CognitoIdentityProviderClient({ region: authRegion });
const authResult = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }),
);
// The gateway's CUSTOM_JWT authorizer requires the ACCESS token (the ID token
// 403s with `insufficient_scope` at the authorizer, before Cedar runs). Both
// tokens carry cognito:groups; read groups off the ID token for readability.
const accessToken = authResult.AuthenticationResult?.AccessToken;
const idToken = authResult.AuthenticationResult?.IdToken;
if (!accessToken || !idToken) { console.error('Auth failed — no access/ID token'); process.exit(1); }

// cognito:groups off the ID token payload (base64url middle segment).
const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
const groups: string[] = Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [];
if (!groups.length) { console.error(`Test user ${email} is in no Cognito groups — cannot demo a group grant.`); process.exit(1); }
const group = groups[0];
console.log(`Authenticated ${email} — cognito:groups = ${JSON.stringify(groups)} (using "${group}")`);

// Read-only AppSync calls as the test user (its JWT). GroupToolGrant read is fine;
// creating/deleting a grant is an admin mutation the user can't do — those go
// through graphql.sh (SigV4/IAM, the admin path) via gqlAdmin() below.
async function gql(query: string, variables: Record<string, unknown> = {}, auth = idToken!): Promise<any> {
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join('; '));
  return json.data;
}

// Admin-path GraphQL via scripts/graphql.sh (SigV4/IAM) — used for the
// GroupToolGrant create/delete the ordinary user isn't authorized to run.
function gqlAdmin(query: string, variables: Record<string, unknown> = {}): any {
  const out = execFileSync(resolve(root, 'scripts/graphql.sh'), [query, JSON.stringify(variables)], { encoding: 'utf8' });
  const json = JSON.parse(out);
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join('; '));
  return json.data;
}

// ── pick a gateway-registered server ──────────────────────────────────────────
const serversData = await gql(`query { listMcpServers { items { id name url gatewayTargetId } } }`);
let gatewayServers: any[] = (serversData.listMcpServers?.items ?? []).filter((s: any) => s.gatewayTargetId && s.url?.includes('gateway.bedrock-agentcore'));
if (argServerName) gatewayServers = gatewayServers.filter((s) => s.name === argServerName);
if (!gatewayServers.length) { console.error('No gateway-registered McpServer found (need a gatewayTargetId + gateway URL).'); process.exit(1); }
const server = gatewayServers[0];
console.log(`Using gateway server "${server.name}" (target=${server.gatewayTargetId})\n  url=${server.url}`);

async function mcpCall(method: string, params: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let body: any = text;
  // The gateway may answer as SSE (text/event-stream) — pull the JSON data line.
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  try { body = JSON.parse(dataLine ? dataLine.slice(5).trim() : text); } catch { /* leave as text */ }
  return { status: res.status, body };
}

// The authoritative DENY/ALLOW signal is a real `tools/call` (NOT `tools/list`,
// which is not Cedar-gated per-tool — it returns 200 `{tools:[]}` either way).
// A Cedar deny is JSON-RPC error -32002 "Tool Execution Denied … policy
// enforcement"; an allow is a result whose payload is the tool's OWN output
// (even a tool-level error like "File not found" means Cedar let the call
// through to the Lambda — that is still an ALLOW at the authorization layer).
function summarize(label: string, r: { status: number; body: any }) {
  const errMsg = r.body?.error?.message ? String(r.body.error.message) : '';
  const isDeny = /policy enforcement|Tool Execution Denied|not authorized|access denied|insufficient_scope/i.test(JSON.stringify(r.body));
  const isAllow = !isDeny && r.body?.result !== undefined;
  const verdict = isDeny ? '→ DENIED' : isAllow ? '→ ALLOWED' : '→ (indeterminate)';
  console.log(`── ${label}: HTTP ${r.status} ${verdict}${errMsg ? ' — ' + errMsg : ''}`);
  console.log('   ' + JSON.stringify(r.body).slice(0, 400));
  return { isDeny, isAllow, status: r.status };
}

// The fully-qualified gateway tool name is `<targetName>___<tool>`. Discover the
// target name from the gateway; the tool defaults to a read-only one (ReadFile
// for s3-tools). Override with --tool if the target exposes different tools.
const gatewayId = new URL(server.url).hostname.split('.')[0];
const targetsOut = execFileSync('aws', [
  'bedrock-agentcore-control', 'list-gateway-targets',
  '--gateway-identifier', gatewayId,
  '--query', `items[?targetId=='${server.gatewayTargetId}'].name`, '--output', 'text',
], { encoding: 'utf8' }).trim();
const targetName = targetsOut || server.name;
const toolName = argToolName ?? 'ReadFile';
const qualifiedTool = `${targetName}___${toolName}`;
const callArgs = { path: 'README.md' }; // harmless read; a tool-level "not found" still proves ALLOW
console.log(`Probing tool: ${qualifiedTool}`);

const callParams = { name: qualifiedTool, arguments: callArgs };

// ── STEP 1: tools/call with NO grant (expect DENY) ───────────────────────────
console.log(`\nSTEP 1 — tools/call ${qualifiedTool} with NO matching GroupToolGrant (ENFORCE → expect DENY):`);
const before = summarize('no-grant', await mcpCall('tools/call', callParams));

// ── STEP 2: add an ALLOW grant for exactly this tool, wait for sync ──────────
console.log(`\nSTEP 2 — create ALLOW GroupToolGrant (${group} -> ${server.name}.${toolName}) and wait for the sync-cedar-policies Lambda to push the Cedar policy…`);
const created = gqlAdmin(
  `mutation Create($input: CreateGroupToolGrantInput!) { createGroupToolGrant(input: $input) { id } }`,
  { input: { group, mcpServerId: server.id, toolName, effect: 'ALLOW' } },
);
const grantId = created.createGroupToolGrant.id;
console.log(`  grant id=${grantId}`);

// ── STEP 3: poll tools/call until ALLOW (sync Lambda + Cedar validation) ─────
let after = before;
const deadline = Date.now() + 150_000;
let attempt = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  attempt++;
  after = summarize(`retry ${attempt}`, await mcpCall('tools/call', callParams));
  if (after.isAllow) break;
}

// ── cleanup ──────────────────────────────────────────────────────────────────
console.log('\nCleanup — deleting the demo grant…');
gqlAdmin(`mutation Del($input: DeleteGroupToolGrantInput!) { deleteGroupToolGrant(input: $input) { id } }`, { input: { id: grantId } });
console.log('  deleted.');

// ── verdict ────────────────────────────────────────────────────────────────
console.log('\n════ RESULT ════');
console.log(`no-grant call : HTTP ${before.status} ${before.isDeny ? 'DENIED ✓' : 'ALLOWED ✗ (expected deny)'}`);
console.log(`after ALLOW   : HTTP ${after.status} ${after.isAllow ? 'ALLOWED ✓' : 'still DENIED ✗'}`);
const pass = before.isDeny && after.isAllow;
console.log(pass ? '\n✓ ENFORCE demonstrated: same user+tool flips from DENY to ALLOW purely via a GroupToolGrant.' : '\n✗ Demo did not show the expected DENY→ALLOW transition — inspect output above.');
process.exit(pass ? 0 : 1);
