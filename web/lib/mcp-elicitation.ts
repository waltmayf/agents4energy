/**
 * Detects and models the AgentCore Gateway's MCP "elicitation" error — JSON-RPC
 * code -32042, returned on a `tools/call` against a gateway target that has an
 * OAUTH_3LO credential provider attached and no vaulted token yet for the
 * calling user (epic #412, slice 4/8). Verbatim shape (AWS ML blog /
 * awslabs/agentcore-samples):
 *
 *   {
 *     "jsonrpc": "2.0", "id": 3,
 *     "error": {
 *       "code": -32042,
 *       "message": "This request requires more information.",
 *       "data": {
 *         "elicitations": [{ "mode": "url", "elicitationId": "...", "url": "...", "message": "..." }]
 *       }
 *     }
 *   }
 *
 * The "session URI" slice 5 (#417) needs for `CompleteResourceTokenAuth` is not
 * a separate field on this payload — AgentCore embeds it as the `request_uri`
 * query parameter of the elicitation `url` (URL session binding) — so it's
 * extracted here rather than left for the next slice to rediscover.
 */

export const MCP_ELICITATION_ERROR_CODE = -32042;

/** AG-UI CUSTOM event name carrying an `McpElicitation` in its `value`. */
export const MCP_ELICITATION_EVENT_NAME = 'mcp_elicitation';

export interface McpElicitation {
  elicitationId: string;
  url: string;
  message?: string;
  mode?: string;
  /** Extracted from `url`'s `request_uri` query param; null if absent/unparseable. */
  sessionUri: string | null;
}

interface RawElicitationEntry {
  mode?: string;
  elicitationId?: string;
  url?: string;
  message?: string;
}

interface RawJsonRpcError {
  code?: number;
  message?: string;
  data?: { elicitations?: RawElicitationEntry[] };
}

function sessionUriFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('request_uri');
  } catch {
    return null;
  }
}

function fromError(err: RawJsonRpcError | null | undefined): McpElicitation | null {
  if (!err || err.code !== MCP_ELICITATION_ERROR_CODE) return null;
  const entries = err.data?.elicitations;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const entry = entries.find((e) => e?.mode === 'url' && e.url && e.elicitationId) ?? entries[0];
  if (!entry?.url || !entry?.elicitationId) return null;
  return {
    elicitationId: entry.elicitationId,
    url: entry.url,
    message: entry.message,
    mode: entry.mode,
    sessionUri: sessionUriFromUrl(entry.url),
  };
}

/**
 * Best-effort JSON parse: also tries to pull a `{...}` substring out of a
 * larger string, since an SDK exception's `.message` often prefixes the JSON
 * payload with its own text (e.g. `RuntimeClientError: {"jsonrpc":...}`).
 */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/**
 * Parse `raw` — a tool-result content string or an SDK stream-exception
 * message — for an MCP elicitation error. Accepts either the full JSON-RPC
 * envelope (`{jsonrpc, error: {...}}`) or a bare error object (`{code, data}`),
 * since which shape reaches us depends on whether the harness normalizes the
 * gateway's response into a regular tool result or surfaces it as a
 * stream-level exception. Returns null for anything else (including malformed
 * JSON), so callers can safely try this on every tool result / exception.
 */
export function parseMcpElicitation(raw: string | null | undefined): McpElicitation | null {
  if (!raw) return null;
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { error?: RawJsonRpcError } & RawJsonRpcError;
  return fromError(obj.error) ?? fromError(obj);
}

/** Human-readable stand-in for the raw JSON-RPC error — shown in place of the protocol payload. */
export function elicitationFriendlyMessage(elicitation: McpElicitation): string {
  return elicitation.message
    ? `🔒 Authentication required: ${elicitation.message}`
    : '🔒 Authentication is required before this tool can run.';
}
