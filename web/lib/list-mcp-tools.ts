import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import { fetchCredential, isExpiredOrExpiringSoon } from '@/lib/mcp-auth';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

export type McpToolResult = {
  tools: Array<{ name: string; description?: string | null; inputSchema?: string | null }>;
  error: string | null;
};

/**
 * List tools for a single MCP server, injecting an OAuth Bearer token when
 * the server has an oauthClientId and a valid stored credential.
 */
export async function listMcpToolsForServer(server: {
  id: string;
  url: string;
  oauthClientId?: string | null;
  headers: Array<{ key: string; value: string }>;
}): Promise<McpToolResult> {
  let headers = server.headers.filter((h) => h.key.trim());

  if (server.oauthClientId) {
    const cred = await fetchCredential(server.id).catch(() => null);
    if (cred && !isExpiredOrExpiringSoon(cred)) {
      headers = [
        ...headers.filter((h) => h.key.toLowerCase() !== 'authorization'),
        { key: 'Authorization', value: `Bearer ${cred.accessToken}` },
      ];
    }
  }

  const res = await (amplifyClient.graphql({
    query: /* GraphQL */ `
      query ListMcpTools($url: String!, $headers: [McpServerHeaderEntryInput]) {
        listMcpTools(url: $url, headers: $headers) {
          tools { name description inputSchema }
          error
        }
      }
    `,
    variables: {
      url: server.url,
      headers: headers.length > 0 ? headers : undefined,
    },
  }) as unknown as Promise<any>);

  const result = res.data?.listMcpTools;
  return {
    tools: result?.tools ?? [],
    error: result?.error ?? null,
  };
}

// Matches the shapes list-mcp-tools/handler.ts's error strings take for an
// auth failure: an HTTP 401/403 status line, or an OAuth2/RFC 6750 error code
// (invalid_token / insufficient_scope) embedded in the response body it
// forwards verbatim. Used to decide whether "Authenticate & list tools" (the
// browser PKCE retry, issue #470) should be offered instead of a bare error.
export function isMcpAuthError(error: string): boolean {
  return /\b(401|403)\b|invalid_token|insufficient_scope|unauthorized/i.test(error);
}
