// Wires the AgentCore Gateway's registered MCP tools into Claude Code (#339,
// slice 2/3 of the auth-unify epic #337).
//
// Every MCP tool call from this container must go through the same
// CUSTOM_JWT-authorizer + Cedar chokepoint the browser HarnessAgent path uses
// (#338's buildTools in web/lib/harness-agent.ts) — never a container-local or
// direct-URL MCP connection. This module never fabricates a `{sub,groups}`
// blob: the invoking user's real Cognito ACCESS token is relayed by the
// caller (see web/lib/claude-code-agent.ts's `cognitoAccessToken` payload
// field) and forwarded here verbatim as `Authorization: Bearer` — the
// gateway's CUSTOM_JWT authorizer reads `cognito:groups` off that same JWT as
// a Cedar principal tag, identically to the harness path.
//
// The gateway rejects a Cognito ID token with `insufficient_scope` (#327) —
// callers must relay the ACCESS token, not the ID token. `accessToken` here
// is opaque to this module either way; it just attaches whatever it's given.
//
// Absent on the webhook (@agentcore-claude) invocation path, which has no
// signed-in browser user to relay a token for — see #340 for that path's
// (separate) machine-identity slice. This module simply omits the gateway
// entry when no token is provided, same as when GATEWAY_ENDPOINT is unset.

const GATEWAY_ENDPOINT = process.env.AGENTCORE_GATEWAY_ENDPOINT || '';

/**
 * Returns the `.mcp.json` server entry for the AgentCore gateway, or null if
 * gateway routing isn't available for this run (no endpoint configured, or no
 * caller token was relayed).
 */
export function gatewayMcpServerEntry({ accessToken, log }) {
  if (!GATEWAY_ENDPOINT) {
    log('[gateway-mcp] AGENTCORE_GATEWAY_ENDPOINT is not configured; skipping gateway MCP tools.');
    return null;
  }
  if (!accessToken) {
    log('[gateway-mcp] no caller Cognito access token was relayed; skipping gateway MCP tools.');
    return null;
  }
  return {
    'agentcore-gateway': {
      type: 'http',
      url: GATEWAY_ENDPOINT,
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  };
}
