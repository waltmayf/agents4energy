# MCP Tool Permissions (Cognito Group → Tool Grants)

Tracks who is *supposed* to be able to call which MCP tool. This is the human-editable model from issue #247 — it is **not yet enforced server-side**. Enforcement (Cedar policy generation + gateway routing) is a separate, still-open issue (#248).

---

## Data model

`GroupToolGrant` (`web/amplify/data/schemas/agentConfig.schema.ts`) is a flat table of rows:

| Field | Meaning |
|---|---|
| `group` | Cognito group name (`admin`, `reservoir-eng`, `drilling` — see `web/amplify/auth/resource.ts`) |
| `mcpServerId` | The `McpServer` this grant applies to |
| `toolName` | An exact tool name as returned by `listMcpTools`, or `"*"` for every tool on that server |
| `effect` | `ALLOW` or `DENY` |

Authorization: admins (`allow.group('admin')`) can create/update/delete; any authenticated user can read (the chat UI needs to read grants to decide what to hide).

There is no default-deny row — **absence of any grant for a server means that server is ungoverned**, and every tool on it stays visible to everyone. A server only becomes "governed" once an admin adds its first grant row, at which point access follows the ALLOW/DENY rows for the signed-in user's groups (DENY wins over ALLOW for the same group; `"*"` matches every tool name).

### Relationship to `AgentMcpServer.enabledTools`

`AgentMcpServer.enabledTools` (a string array on the old per-agent join row) is **deprecated** and unread by any code path. It was scoped per-(agent, server); `GroupToolGrant` is scoped per-(group, server, tool) and therefore applies uniformly across every agent that exposes a given server. The field is left in the schema (nullable) rather than dropped, to avoid a destructive migration — new code should not read or write it.

---

## Admin UI

The **Permissions** tab on `/agents` (visible only to signed-in users in the `admin` Cognito group) lists every MCP server's tools against the three Cognito groups. Click a cell to cycle it through `unset → ALLOW → DENY → unset`.

Adding a server here has no default-deny effect until a grant row actually exists on it — see the ungoverned-by-default note above.

---

## Client-side (non-authoritative) enforcement

Two places apply this model purely for UX — hiding tools a user isn't expected to use — **not** as a security boundary:

- `web/app/(with-auth)/chat/use-agents.ts` drops an entire MCP server from an agent's tool list if the server is governed and none of the signed-in user's groups are ALLOW-granted on it (checked against the `"*"` wildcard).
- `web/app/(with-auth)/chat/page.tsx`'s `AgentToolsDialog` filters at the individual tool level, so a governed server can still show the subset of tools the user's groups are allowed to call.

Both reuse `web/lib/tool-permissions.ts` (`isToolGrantedToAnyGroup`).

**This client-side filtering can be bypassed** by anyone with direct API/gateway access — a user's actual tool-call permissions are unenforced until #248 lands Cedar policy generation and routes calls through the gateway.
