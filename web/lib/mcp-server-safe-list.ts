// Resilient wrapper around `McpServer.list()` (issue #387).
//
// `McpServer.name` is `a.string().required()`, and Amplify's generated
// connection type is `items: [McpServer!]!` — both the array and its elements
// are non-null. If a *single* row has a null `name` (possible only via a
// direct-DynamoDB write that bypasses AppSync input validation), AppSync's
// non-null propagation nulls the whole `listMcpServers` result, not just that
// row. Every caller that renders the servers list then silently loses every
// real row (`data ?? []` swallows the error), even though only one row is bad.
//
// The fast path here is the plain list call, unchanged from before. Only when
// it comes back with errors do we fall back to an id-only relist (which can't
// trip non-null propagation, since it never selects `name`) followed by a
// per-id `get()` — a single-row query is scoped to one object, so a poisoned
// row's error can't take down its siblings. A row whose hydration still fails
// renders with a fallback label instead of vanishing.
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

const client = generateClient<Schema>({ authMode: 'userPool' });

export type SafeListParams = {
  filter?: Record<string, unknown>;
  limit?: number;
  nextToken?: string | null;
};

export type SafeListResult = { data: any[]; nextToken: string | null };

export const MCP_SERVER_FALLBACK_NAME = '(unnamed MCP server — invalid record, delete and recreate)';

function fallbackRow(id: string): any {
  return {
    id,
    name: MCP_SERVER_FALLBACK_NAME,
    url: '',
    description: null,
    serverType: null,
    enabled: false,
    headers: [],
    oauthClientId: null,
    gatewayTargetId: null,
  };
}

export async function safeListMcpServers(params: SafeListParams = {}): Promise<SafeListResult> {
  const res = (await client.models.McpServer.list(params as any)) as any;
  if (!res.errors?.length) {
    return { data: res.data ?? [], nextToken: res.nextToken ?? null };
  }
  console.warn(
    '[mcp-server-list] listMcpServers returned errors (likely a row with a null required field); retrying id-only',
    res.errors,
  );
  const idRes = (await client.models.McpServer.list({ ...params, selectionSet: ['id'] } as any)) as any;
  const ids: string[] = (idRes.data ?? []).map((r: any) => r.id);
  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        const g = (await client.models.McpServer.get({ id })) as any;
        return g.errors?.length || !g.data ? fallbackRow(id) : g.data;
      } catch {
        return fallbackRow(id);
      }
    }),
  );
  return { data: rows, nextToken: idRes.nextToken ?? null };
}
