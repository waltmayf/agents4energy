#!/usr/bin/env tsx
// Idempotently provisions a pack manifest (Agent + McpServers + AgentMcpServer
// joins + GroupToolGrant rows) against the deployed backend via authenticated
// GraphQL. Safe to re-run — matches existing rows by slug/name and updates
// rather than duplicates. See packs/README.md for the manifest format.
//
// Usage:
//   npx tsx scripts/deploy-pack.ts <path-to-pack.json> [--dry-run]
//   ./scripts/deploy-pack.sh <pack-id> [--dry-run]
//
// Deletion/teardown is out of scope: packs are additive only — re-running
// after removing an entry from pack.json leaves the previously-created row in
// place rather than deleting it.
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type PackMcpServer = {
  name: string;
  url: string;
  description?: string;
  serverType?: 'agentcore' | 'mcp';
  headers?: Array<{ key: string; value: string }>;
  authSecretArn?: string;
  oauthClientId?: string;
  gatewayTargetId?: string;
  enabled?: boolean;
};

type PackManifest = {
  id: string;
  name: string;
  description?: string;
  agent: {
    name: string;
    slug?: string;
    description?: string;
    systemPromptText?: string;
    systemPromptFile?: string;
    modelId?: string;
    enabled?: boolean;
  };
  mcpServers: PackMcpServer[];
  groupGrants?: Array<{ group: string; toolName: string; effect: 'ALLOW' | 'DENY' }>;
};

function usageError(message: string): never {
  console.error(message);
  console.error('Usage: npx tsx scripts/deploy-pack.ts <path-to-pack.json> [--dry-run]');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const packPathArg = process.argv.slice(2).find((a) => a !== '--dry-run');
if (!packPathArg) usageError('Missing pack.json path.');

const packPath = resolve(process.cwd(), packPathArg);
if (!existsSync(packPath)) usageError(`Pack manifest not found: ${packPath}`);
const packDir = dirname(packPath);

let manifest: PackManifest;
try {
  manifest = JSON.parse(readFileSync(packPath, 'utf8'));
} catch (err) {
  usageError(`Failed to parse ${packPath} as JSON: ${(err as Error).message}`);
}

// Lightweight structural validation against the #472 pack manifest schema
// (packages/shared-types/src/packManifest.ts) — checks the required shape
// without pulling in a JSON Schema validator dependency for a handful of checks.
function validateManifest(m: PackManifest): string[] {
  const errors: string[] = [];
  if (typeof m.id !== 'string' || !m.id) errors.push('"id" is required and must be a string.');
  if (typeof m.name !== 'string' || !m.name) errors.push('"name" is required and must be a string.');
  if (!m.agent || typeof m.agent !== 'object') {
    errors.push('"agent" is required and must be an object.');
  } else if (typeof m.agent.name !== 'string' || !m.agent.name) {
    errors.push('"agent.name" is required and must be a string.');
  }
  if (!Array.isArray(m.mcpServers)) {
    errors.push('"mcpServers" is required and must be an array.');
  } else {
    m.mcpServers.forEach((server, i) => {
      if (typeof server.name !== 'string' || !server.name) errors.push(`mcpServers[${i}].name is required.`);
      if (typeof server.url !== 'string' || !server.url) errors.push(`mcpServers[${i}].url is required.`);
    });
  }
  if (m.groupGrants !== undefined) {
    if (!Array.isArray(m.groupGrants)) {
      errors.push('"groupGrants" must be an array when present.');
    } else {
      m.groupGrants.forEach((grant, i) => {
        if (typeof grant.group !== 'string' || !grant.group) errors.push(`groupGrants[${i}].group is required.`);
        if (typeof grant.toolName !== 'string' || !grant.toolName) errors.push(`groupGrants[${i}].toolName is required.`);
        if (grant.effect !== 'ALLOW' && grant.effect !== 'DENY') errors.push(`groupGrants[${i}].effect must be "ALLOW" or "DENY".`);
      });
    }
  }
  return errors;
}

const manifestErrors = validateManifest(manifest);
if (manifestErrors.length > 0) {
  console.error(`Pack manifest ${packPath} failed validation:`);
  manifestErrors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Resolve the agent's system prompt: inline text takes precedence over a
// sibling markdown file (matching packManifest.ts's documented precedence).
let systemPromptText = manifest.agent.systemPromptText;
if (!systemPromptText && manifest.agent.systemPromptFile) {
  const promptPath = resolve(packDir, manifest.agent.systemPromptFile);
  if (!existsSync(promptPath)) usageError(`systemPromptFile not found: ${promptPath}`);
  systemPromptText = readFileSync(promptPath, 'utf8');
}

// --- Auth (reuse create-mcp-server.ts's Cognito USER_PASSWORD_AUTH pattern) ---
const envPath = resolve(root, 'scripts/.env.local');
if (!existsSync(envPath)) usageError('Missing scripts/.env.local (needs TEST_USER_EMAIL / TEST_USER_PASSWORD).');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);

const email = env.TEST_USER_EMAIL;
const password = env.TEST_USER_PASSWORD;
if (!email || !password) usageError('Missing TEST_USER_EMAIL or TEST_USER_PASSWORD in scripts/.env.local');

const amplifyOutputsPath = resolve(root, 'web/amplify_outputs.json');
if (!existsSync(amplifyOutputsPath)) usageError(`${amplifyOutputsPath} not found. Run 'pnpm deploy' first.`);
const amplifyOutputs = JSON.parse(readFileSync(amplifyOutputsPath, 'utf8'));
const { user_pool_client_id: clientId, aws_region: authRegion } = amplifyOutputs.auth;
const graphqlUrl: string = amplifyOutputs.data.url;

const cognito = new CognitoIdentityProviderClient({ region: authRegion });
const authResult = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }),
);
const idToken = authResult.AuthenticationResult?.IdToken;
if (!idToken) usageError('Authentication failed — no ID token returned.');

async function gql<T = Record<string, unknown>>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: idToken! },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data as T;
}

function diffFields<D extends Record<string, unknown>>(existing: Record<string, unknown>, desired: D): Partial<D> {
  const diff: Partial<D> = {};
  for (const key of Object.keys(desired) as Array<keyof D>) {
    const existingValue = existing[key as string] ?? null;
    const desiredValue = desired[key] ?? null;
    if (JSON.stringify(existingValue) !== JSON.stringify(desiredValue)) {
      diff[key] = desired[key];
    }
  }
  return diff;
}

function logPlan(action: string) {
  console.log(`${dryRun ? '[dry-run] would ' : ''}${action}`);
}

// --- Agent: find-or-create/update, matched by slug ---
async function upsertAgent(): Promise<{ id: string; slug: string }> {
  const slug = manifest.agent.slug ?? slugify(manifest.agent.name);
  const desired = {
    name: manifest.agent.name,
    slug,
    description: manifest.agent.description ?? null,
    systemPromptText: systemPromptText ?? null,
    modelId: manifest.agent.modelId ?? null,
    enabled: manifest.agent.enabled ?? true,
  };

  const existing = await gql<{ listAgents: { items: Array<Record<string, unknown> & { id: string }> } }>(
    `query ListAgents($filter: ModelAgentFilterInput) {
      listAgents(filter: $filter) { items { id name slug description systemPromptText modelId enabled } }
    }`,
    { filter: { slug: { eq: slug } } },
  );
  const item = existing.listAgents.items[0];

  if (!item) {
    logPlan(`create Agent slug=${slug}`);
    if (dryRun) return { id: '<dry-run>', slug };
    const created = await gql<{ createAgent: { id: string } }>(
      `mutation CreateAgent($input: CreateAgentInput!) { createAgent(input: $input) { id } }`,
      { input: desired },
    );
    console.log(`Created Agent slug=${slug} id=${created.createAgent.id}`);
    return { id: created.createAgent.id, slug };
  }

  const diff = diffFields(item, desired);
  if (Object.keys(diff).length === 0) {
    console.log(`Agent slug=${slug} already up to date (id=${item.id}).`);
    return { id: item.id, slug };
  }
  logPlan(`update Agent slug=${slug} id=${item.id} fields=${JSON.stringify(diff)}`);
  if (!dryRun) {
    await gql(
      `mutation UpdateAgent($input: UpdateAgentInput!) { updateAgent(input: $input) { id } }`,
      { input: { id: item.id, ...diff } },
    );
    console.log(`Updated Agent slug=${slug} id=${item.id}.`);
  }
  return { id: item.id, slug };
}

// --- McpServer: find-or-create/update, matched by name ---
async function upsertMcpServer(server: PackMcpServer): Promise<{ id: string; name: string }> {
  const desired = {
    name: server.name,
    url: server.url,
    description: server.description ?? null,
    serverType: server.serverType ?? 'mcp',
    headers: server.headers ?? [],
    authSecretArn: server.authSecretArn ?? null,
    oauthClientId: server.oauthClientId ?? null,
    gatewayTargetId: server.gatewayTargetId ?? null,
    enabled: server.enabled ?? true,
  };

  const existing = await gql<{ listMcpServers: { items: Array<Record<string, unknown> & { id: string }> } }>(
    `query ListMcpServers($filter: ModelMcpServerFilterInput) {
      listMcpServers(filter: $filter) {
        items { id name url description serverType headers { key value } authSecretArn oauthClientId gatewayTargetId enabled }
      }
    }`,
    { filter: { name: { eq: server.name } } },
  );
  const item = existing.listMcpServers.items[0];

  if (!item) {
    logPlan(`create McpServer name=${server.name}`);
    if (dryRun) return { id: '<dry-run>', name: server.name };
    const created = await gql<{ createMcpServer: { id: string } }>(
      `mutation CreateMcpServer($input: CreateMcpServerInput!) { createMcpServer(input: $input) { id } }`,
      { input: desired },
    );
    console.log(`Created McpServer name=${server.name} id=${created.createMcpServer.id}`);
    return { id: created.createMcpServer.id, name: server.name };
  }

  const diff = diffFields(item, desired);
  if (Object.keys(diff).length === 0) {
    console.log(`McpServer name=${server.name} already up to date (id=${item.id}).`);
    return { id: item.id, name: server.name };
  }
  logPlan(`update McpServer name=${server.name} id=${item.id} fields=${JSON.stringify(diff)}`);
  if (!dryRun) {
    await gql(
      `mutation UpdateMcpServer($input: UpdateMcpServerInput!) { updateMcpServer(input: $input) { id } }`,
      { input: { id: item.id, ...diff } },
    );
    console.log(`Updated McpServer name=${server.name} id=${item.id}.`);
  }
  return { id: item.id, name: server.name };
}

// --- AgentMcpServer join: ensure existence, matched by (agentId, mcpServerId) ---
async function ensureAgentMcpServerLink(agentId: string, mcpServerId: string, mcpServerName: string): Promise<void> {
  if (dryRun && agentId === '<dry-run>') {
    logPlan(`link Agent to McpServer name=${mcpServerName}`);
    return;
  }
  const existing = await gql<{ listAgentMcpServers: { items: Array<{ id: string }> } }>(
    `query ListAgentMcpServers($filter: ModelAgentMcpServerFilterInput) {
      listAgentMcpServers(filter: $filter) { items { id } }
    }`,
    { filter: { agentId: { eq: agentId }, mcpServerId: { eq: mcpServerId } } },
  );
  if (existing.listAgentMcpServers.items[0]) {
    console.log(`Agent already linked to McpServer name=${mcpServerName}.`);
    return;
  }
  logPlan(`link Agent to McpServer name=${mcpServerName}`);
  if (dryRun) return;
  await gql(
    `mutation CreateAgentMcpServer($input: CreateAgentMcpServerInput!) { createAgentMcpServer(input: $input) { id } }`,
    { input: { agentId, mcpServerId } },
  );
  console.log(`Linked Agent to McpServer name=${mcpServerName}.`);
}

// --- GroupToolGrant: find-or-create/update, matched by (group, mcpServerId, toolName) ---
// The manifest's groupGrants entries aren't scoped to a specific mcpServer (the
// pack format doesn't carry that reference), so each grant is applied against
// every McpServer defined in this pack — sufficient for v1 packs, which bundle
// a small, closely-related set of tools under one grant policy.
async function upsertGroupToolGrant(
  grant: { group: string; toolName: string; effect: 'ALLOW' | 'DENY' },
  mcpServerId: string,
  mcpServerName: string,
): Promise<void> {
  if (dryRun && mcpServerId === '<dry-run>') {
    logPlan(`grant group=${grant.group} tool=${grant.toolName} effect=${grant.effect} on McpServer name=${mcpServerName}`);
    return;
  }
  const existing = await gql<{ listGroupToolGrants: { items: Array<{ id: string; effect: string }> } }>(
    `query ListGroupToolGrants($filter: ModelGroupToolGrantFilterInput) {
      listGroupToolGrants(filter: $filter) { items { id effect } }
    }`,
    { filter: { group: { eq: grant.group }, mcpServerId: { eq: mcpServerId }, toolName: { eq: grant.toolName } } },
  );
  const item = existing.listGroupToolGrants.items[0];

  if (!item) {
    logPlan(`grant group=${grant.group} tool=${grant.toolName} effect=${grant.effect} on McpServer name=${mcpServerName}`);
    if (dryRun) return;
    await gql(
      `mutation CreateGroupToolGrant($input: CreateGroupToolGrantInput!) { createGroupToolGrant(input: $input) { id } }`,
      { input: { group: grant.group, mcpServerId, toolName: grant.toolName, effect: grant.effect } },
    );
    console.log(`Created GroupToolGrant group=${grant.group} tool=${grant.toolName} on McpServer name=${mcpServerName}.`);
    return;
  }

  if (item.effect === grant.effect) {
    console.log(`GroupToolGrant group=${grant.group} tool=${grant.toolName} on McpServer name=${mcpServerName} already up to date.`);
    return;
  }
  logPlan(`update GroupToolGrant group=${grant.group} tool=${grant.toolName} on McpServer name=${mcpServerName} effect=${item.effect}->${grant.effect}`);
  if (dryRun) return;
  await gql(
    `mutation UpdateGroupToolGrant($input: UpdateGroupToolGrantInput!) { updateGroupToolGrant(input: $input) { id } }`,
    { input: { id: item.id, effect: grant.effect } },
  );
  console.log(`Updated GroupToolGrant group=${grant.group} tool=${grant.toolName} on McpServer name=${mcpServerName}.`);
}

console.log(`${dryRun ? '[dry-run] ' : ''}Deploying pack "${manifest.id}" (${packPath})`);

const agent = await upsertAgent();

const servers: Array<{ id: string; name: string }> = [];
for (const server of manifest.mcpServers) {
  const mcpServer = await upsertMcpServer(server);
  await ensureAgentMcpServerLink(agent.id, mcpServer.id, mcpServer.name);
  servers.push(mcpServer);
}

for (const grant of manifest.groupGrants ?? []) {
  for (const server of servers) {
    await upsertGroupToolGrant(grant, server.id, server.name);
  }
}

console.log(`${dryRun ? '[dry-run] ' : ''}Done deploying pack "${manifest.id}".`);
