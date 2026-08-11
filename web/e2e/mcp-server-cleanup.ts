// Programmatic McpServer cleanup for the e2e suite (issue #308).
//
// `mcp-auth.spec.ts` creates real `McpServer` records against the *shared*
// deployed sandbox backend. When a `beforeEach`/`beforeAll` times out its
// matching UI-driven cleanup never runs, so orphans accumulate — and once the
// table is large enough the create/list round-trip blows the test timeouts,
// cascading failures across the suite (the exact red-`main` failure in #308).
//
// The durable fix is to delete e2e-created servers directly via the AppSync
// API (SigV4-signed, same as scripts/graphql.sh) rather than clicking through
// the UI: an API delete can't be skipped by a timed-out UI assertion. This
// module is used two ways:
//   1. global purge before the run (mcp-cleanup.setup.ts) — removes any orphans
//      a previous run leaked, so a bad run can't poison the next one;
//   2. teardown inside the spec — deletes the ids a test created even on failure.
//
// It matches ONLY e2e-created rows: the `E2E-` sentinel prefix all new specs
// use, plus the two legacy name patterns (`OAuth Test <ts>` / `Lifecycle Test
// <ts>`) that predate the sentinel, so historical orphans get swept too. The
// two real gateway servers ("S3 Filesystem Tools", "Knowledge Graph Tools")
// never match and are always preserved.

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/** Sentinel every e2e-created MCP server name must start with. */
export const E2E_MCP_PREFIX = 'E2E-';

// Legacy names created before the sentinel existed — matched so a first run
// after this change sweeps any orphans left by older runs.
const LEGACY_PREFIXES = ['OAuth Test ', 'Lifecycle Test '];

function isE2eServerName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.startsWith(E2E_MCP_PREFIX) || LEGACY_PREFIXES.some((p) => name.startsWith(p));
}

interface GraphqlConfig {
  url: string;
  region: string;
  // Cognito user-pool JWT for the e2e test user. When present, requests go
  // through AppSync's Cognito authorizer (which `McpServer`'s
  // `allow.authenticated()` rule accepts). When absent — a local admin run —
  // we fall back to SigV4/IAM. See the resolver below and issue #356.
  idToken?: string;
  // Config needed to mint the JWT (only present from e2e-config.json in CI).
  userPoolClientId?: string;
  testUserEmailSsmPath?: string;
  testUserPasswordSsmPath?: string;
}

/**
 * Resolve the AppSync endpoint + region for cleanup requests. Prefers the
 * `graphqlUrl` published into web/e2e-config.json by scripts/build.sh (and,
 * from that same file, the Cognito client id + test-user SSM paths needed to
 * mint a user-pool JWT); falls back to web/amplify_outputs.json for a local run
 * against a sandbox deploy. Returns null when neither is available (purge then
 * no-ops with a warning).
 */
export function resolveGraphqlConfig(): GraphqlConfig | null {
  const e2eConfigPath = resolve(__dirname, '../e2e-config.json');
  if (existsSync(e2eConfigPath)) {
    const cfg = JSON.parse(readFileSync(e2eConfigPath, 'utf8'));
    if (cfg.graphqlUrl) {
      return {
        url: cfg.graphqlUrl,
        region: cfg.region ?? 'us-east-1',
        userPoolClientId: cfg.userPoolClientId,
        testUserEmailSsmPath: cfg.testUserEmailSsmPath,
        testUserPasswordSsmPath: cfg.testUserPasswordSsmPath,
      };
    }
  }
  const outputsPath = resolve(__dirname, '../amplify_outputs.json');
  if (existsSync(outputsPath)) {
    const o = JSON.parse(readFileSync(outputsPath, 'utf8'));
    if (o?.data?.url) {
      return {
        url: o.data.url,
        region: o.data.aws_region ?? 'us-east-1',
        userPoolClientId: o?.auth?.user_pool_client_id,
        testUserEmailSsmPath: o?.custom?.e2e_test_user_email_ssm_path,
        testUserPasswordSsmPath: o?.custom?.e2e_test_user_password_ssm_path,
      };
    }
  }
  return null;
}

/**
 * Mint a Cognito user-pool id token for the e2e test user, using the same
 * SSM-credentials + USER_PASSWORD_AUTH flow as auth.setup.ts. This is what lets
 * cleanup delete `McpServer` rows in CI: the CI runner's IAM role is NOT granted
 * `appsync:GraphQL`, but the model's `allow.authenticated()` rule accepts a
 * user-pool JWT (issue #356). Returns null if the config or SSM values are
 * missing, so callers transparently fall back to SigV4 for a local admin run.
 */
async function fetchTestUserIdToken(cfg: GraphqlConfig): Promise<string | null> {
  if (!cfg.userPoolClientId || !cfg.testUserEmailSsmPath || !cfg.testUserPasswordSsmPath) {
    return null;
  }
  try {
    const ssm = new SSMClient({ region: cfg.region });
    const [emailParam, passwordParam] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: cfg.testUserEmailSsmPath })),
      ssm.send(new GetParameterCommand({ Name: cfg.testUserPasswordSsmPath, WithDecryption: true })),
    ]);
    const email = emailParam.Parameter?.Value;
    const password = passwordParam.Parameter?.Value;
    if (!email || !password) return null;

    const cognito = new CognitoIdentityProviderClient({ region: cfg.region });
    const auth = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: cfg.userPoolClientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    );
    return auth.AuthenticationResult?.IdToken ?? null;
  } catch (err) {
    console.warn('[mcp-cleanup] Could not mint test-user JWT; will fall back to SigV4:', err);
    return null;
  }
}

/**
 * Resolve the endpoint config AND attach a user-pool JWT when the CI config is
 * present. This is the entry point every mutating caller should use: in CI the
 * returned config carries `idToken` (so requests use the Cognito authorizer the
 * McpServer model accepts); locally, minting is skipped and callers fall back to
 * SigV4. Returns null when no endpoint is resolvable at all.
 */
async function resolveAuthedGraphqlConfig(): Promise<GraphqlConfig | null> {
  const cfg = resolveGraphqlConfig();
  if (!cfg) return null;
  const idToken = await fetchTestUserIdToken(cfg);
  return idToken ? { ...cfg, idToken } : cfg;
}

const credentialProvider = fromNodeProviderChain();

async function signedGraphql<T = unknown>(
  cfg: GraphqlConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const endpoint = new URL(cfg.url);
  const body = JSON.stringify({ query, variables });

  let headers: Record<string, string>;
  if (cfg.idToken) {
    // Cognito user-pool authorizer — matches McpServer's allow.authenticated()
    // rule and needs no IAM grant (issue #356).
    headers = {
      'Content-Type': 'application/json',
      host: endpoint.hostname,
      Authorization: cfg.idToken,
    };
  } else {
    // Local admin fallback: SigV4/IAM (dev creds usually have appsync:GraphQL).
    const request = new HttpRequest({
      method: 'POST',
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname,
      headers: {
        'Content-Type': 'application/json',
        host: endpoint.hostname,
      },
      body,
    });
    const signer = new SignatureV4({
      credentials: credentialProvider,
      region: cfg.region,
      service: 'appsync',
      sha256: Sha256,
    });
    const signed = await signer.sign(request);
    headers = signed.headers as Record<string, string>;
  }

  const res = await fetch(cfg.url, { method: 'POST', headers, body });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) {
    throw new Error(`AppSync GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

interface McpServerRow {
  id: string;
  name: string | null;
  serverType: string | null;
}

/** URL fragment identifying an AgentCore gateway MCP server. */
export const GATEWAY_URL_FRAGMENT = 'gateway.bedrock-agentcore';

/**
 * Return the distinct URLs of every deployed AgentCore gateway MCP endpoint.
 * Used by mcp-gateway-oauth-discovery.spec.ts (#328) so the discovery-chain
 * assertion runs against the real deployed gateway instead of vacuously skipping.
 *
 * Reads the endpoint from the STATIC build outputs — `agentcoreGatewayEndpoint`
 * in web/e2e-config.json (published by scripts/build.sh), falling back to
 * `custom.agentcore_gateway_endpoint` in web/amplify_outputs.json for a local
 * run. It deliberately does NOT query AppSync: the CI e2e IAM role isn't granted
 * `appsync:GraphQL`, so a SigV4-signed `listMcpServers` returned
 * `UnauthorizedException: Permission denied` and failed the guard test. The
 * gateway URL is a fixed deploy output, so no authorized query is needed.
 * Returns [] when no endpoint is configured (the spec then skips).
 */
export async function listGatewayMcpServerUrls(): Promise<string[]> {
  const endpoint = resolveGatewayEndpoint();
  if (!endpoint) {
    console.warn('[mcp-gateway] No AgentCore gateway endpoint configured; skipping discovery test.');
    return [];
  }
  return endpoint.includes(GATEWAY_URL_FRAGMENT) ? [endpoint] : [];
}

/**
 * Resolve the AgentCore gateway MCP endpoint from the same static build outputs
 * resolveGraphqlConfig() reads: e2e-config.json first (CI), then
 * amplify_outputs.json (local sandbox). Returns null when neither carries it.
 */
function resolveGatewayEndpoint(): string | null {
  const e2eConfigPath = resolve(__dirname, '../e2e-config.json');
  if (existsSync(e2eConfigPath)) {
    const cfg = JSON.parse(readFileSync(e2eConfigPath, 'utf8'));
    if (cfg.agentcoreGatewayEndpoint) return cfg.agentcoreGatewayEndpoint as string;
  }
  const outputsPath = resolve(__dirname, '../amplify_outputs.json');
  if (existsSync(outputsPath)) {
    const o = JSON.parse(readFileSync(outputsPath, 'utf8'));
    if (o?.custom?.agentcore_gateway_endpoint) return o.custom.agentcore_gateway_endpoint as string;
  }
  return null;
}

/** List every McpServer (following pagination). */
async function listAllMcpServers(cfg: GraphqlConfig): Promise<McpServerRow[]> {
  const items: McpServerRow[] = [];
  let nextToken: string | null = null;
  do {
    type ListResult = { listMcpServers: { items: McpServerRow[]; nextToken: string | null } };
    const data: ListResult = await signedGraphql<ListResult>(
      cfg,
      `query List($nextToken: String) {
         listMcpServers(limit: 1000, nextToken: $nextToken) {
           items { id name serverType }
           nextToken
         }
       }`,
      { nextToken },
    );
    items.push(...data.listMcpServers.items);
    nextToken = data.listMcpServers.nextToken;
  } while (nextToken);
  return items;
}

async function deleteMcpServerById(cfg: GraphqlConfig, id: string): Promise<void> {
  await signedGraphql(cfg, `mutation D($id: ID!) { deleteMcpServer(input: { id: $id }) { id } }`, { id });
}

/**
 * Delete a specific set of McpServer ids (used by spec teardown to remove what
 * a test created, even if the test failed mid-way). Never throws — cleanup must
 * not turn a green run red — but logs any failures.
 */
export async function deleteMcpServersByIds(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return;
  const cfg = await resolveAuthedGraphqlConfig();
  if (!cfg) {
    console.warn('[mcp-cleanup] No GraphQL endpoint resolved; skipping id-based teardown.');
    return;
  }
  for (const id of unique) {
    try {
      await deleteMcpServerById(cfg, id);
    } catch (err) {
      console.warn(`[mcp-cleanup] Failed to delete McpServer ${id}:`, err);
    }
  }
}

/**
 * Delete every e2e-created McpServer (sentinel + legacy patterns), preserving
 * real servers. Returns the number deleted. Never throws.
 */
export async function purgeE2eMcpServers(): Promise<number> {
  const cfg = await resolveAuthedGraphqlConfig();
  if (!cfg) {
    console.warn('[mcp-cleanup] No GraphQL endpoint resolved (no e2e-config.json graphqlUrl or amplify_outputs.json); skipping purge.');
    return 0;
  }
  let deleted = 0;
  try {
    const all = await listAllMcpServers(cfg);
    const orphans = all.filter((s) => isE2eServerName(s.name));
    for (const s of orphans) {
      try {
        await deleteMcpServerById(cfg, s.id);
        deleted++;
      } catch (err) {
        console.warn(`[mcp-cleanup] Failed to delete "${s.name}" (${s.id}):`, err);
      }
    }
    console.log(`[mcp-cleanup] Purged ${deleted} e2e McpServer record(s); ${all.length - orphans.length} real server(s) preserved.`);
  } catch (err) {
    console.warn('[mcp-cleanup] Purge failed (continuing — tests will still run):', err);
  }
  return deleted;
}
