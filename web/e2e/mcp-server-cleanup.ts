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
}

/**
 * Resolve the AppSync endpoint + region for signed requests. Prefers the
 * `graphqlUrl` published into web/e2e-config.json by scripts/build.sh; falls
 * back to web/amplify_outputs.json for a local run against a sandbox deploy.
 * Returns null when neither is available (purge then no-ops with a warning).
 */
export function resolveGraphqlConfig(): GraphqlConfig | null {
  const e2eConfigPath = resolve(__dirname, '../e2e-config.json');
  if (existsSync(e2eConfigPath)) {
    const cfg = JSON.parse(readFileSync(e2eConfigPath, 'utf8'));
    if (cfg.graphqlUrl) {
      return { url: cfg.graphqlUrl, region: cfg.region ?? 'us-east-1' };
    }
  }
  const outputsPath = resolve(__dirname, '../amplify_outputs.json');
  if (existsSync(outputsPath)) {
    const o = JSON.parse(readFileSync(outputsPath, 'utf8'));
    if (o?.data?.url) {
      return { url: o.data.url, region: o.data.aws_region ?? 'us-east-1' };
    }
  }
  return null;
}

const credentialProvider = fromNodeProviderChain();

async function signedGraphql<T = unknown>(
  cfg: GraphqlConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const endpoint = new URL(cfg.url);
  const body = JSON.stringify({ query, variables });
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
  const res = await fetch(cfg.url, { method: signed.method, headers: signed.headers as Record<string, string>, body });
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
 * Return the distinct URLs of every deployed AgentCore gateway MCP server,
 * queried straight from AppSync (SigV4-signed) rather than scraped from the UI.
 * Used by mcp-gateway-oauth-discovery.spec.ts (#328) so the discovery-chain
 * assertion runs against the real deployed gateway instead of vacuously
 * skipping when the UI row isn't rendered. Returns [] when no endpoint resolves
 * or no gateway server exists.
 */
export async function listGatewayMcpServerUrls(): Promise<string[]> {
  const cfg = resolveGraphqlConfig();
  if (!cfg) {
    console.warn('[mcp-gateway] No GraphQL endpoint resolved; cannot list gateway servers.');
    return [];
  }
  type Row = { id: string; url: string | null };
  const urls = new Set<string>();
  let nextToken: string | null = null;
  do {
    type ListResult = { listMcpServers: { items: Row[]; nextToken: string | null } };
    const data: ListResult = await signedGraphql<ListResult>(
      cfg,
      `query ListUrls($nextToken: String) {
         listMcpServers(limit: 1000, nextToken: $nextToken) {
           items { id url }
           nextToken
         }
       }`,
      { nextToken },
    );
    for (const row of data.listMcpServers.items) {
      if (row.url?.includes(GATEWAY_URL_FRAGMENT)) urls.add(row.url);
    }
    nextToken = data.listMcpServers.nextToken;
  } while (nextToken);
  return [...urls];
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
  const cfg = resolveGraphqlConfig();
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
  const cfg = resolveGraphqlConfig();
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
