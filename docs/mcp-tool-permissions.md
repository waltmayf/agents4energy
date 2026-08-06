# MCP Tool Permissions (Cognito Group → Tool Grants)

Tracks who is *supposed* to be able to call which MCP tool. This is the human-editable model from issue #247 — it is **not yet enforced server-side**. Enforcement (Cedar policy generation + gateway routing) is a separate, still-open issue (#248), split into three slices: #271 (this doc's Cedar section — policy engine config only), #272 (generate policies from `GroupToolGrant`), #273 (route tool calls through the gateway so denial is authoritative).

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

---

## Cedar policy engine (config only — #271)

`agent/default/agentcore/agentcore.json` now configures a Cedar `policyEngines` entry (`DefaultCedar`) and associates it with `default-gateway` via `policyEngineConfiguration` in `mode: "LOG_ONLY"`. This is **config only**: no tool calls are routed through the gateway yet (`web/lib/harness-agent.ts` still calls each `McpServer` URL directly as a `remote_mcp` tool), so the engine has nothing to evaluate in practice. `LOG_ONLY` is a placeholder — it becomes meaningful once #273 routes calls through the gateway, at which point it should move to `ENFORCE`.

Two static, hand-written policies seed the engine as a smoke test for `agentcore validate`; both are replaced by generated policies in #272:

| Policy | Effect |
|---|---|
| `AdminAllowAllTools` | `permit`s any `AgentCore::OAuthUser` whose `cognito:groups` tag contains `admin` to call any tool on `default-gateway`. |
| `DefaultDenyUnauthenticated` | `forbid`s any principal that isn't an `AgentCore::OAuthUser` (documents Cedar's existing default-deny; not a behavior change on its own). |

### The contract for #272 (policy generation) and #273 (routing)

Because `default-gateway` uses `authorizerType: "CUSTOM_JWT"` (Cognito), Cedar principals are typed `AgentCore::OAuthUser`, built from the caller's JWT — every claim in the token becomes a **tag** on the principal, readable via `principal.hasTag("<claim>")` / `principal.getTag("<claim>")`. There is no first-class "group" entity; group membership is just a claim value on the principal, matched with `getTag(...) like "*<group>*"` (Cognito's `cognito:groups` claim is a space/comma-joined string in a JWT, not a Cedar set) or an exact `==` if the claim is normalized to a single value upstream. The exact claim key available to the gateway (`cognito:groups` vs. a custom-mapped claim) depends on the Cognito authorizer's claim passthrough and should be confirmed against a real token in #272, not assumed from this placeholder.

Mapping `GroupToolGrant` rows (`group`, `mcpServerId` → tool name via the target's registered name on the gateway, `toolName`, `effect`) to Cedar for #272:

- **Principal** — `principal is AgentCore::OAuthUser` guarded by `principal.getTag("cognito:groups") like "*<group>*"`.
- **Action** — one Cedar action per gateway tool, named after the tool's fully-qualified gateway name (see the insurance example in AWS's Policy docs: `AgentCore::Action::"<TargetName>___<toolName>"`). A `GroupToolGrant.toolName == "*"` row maps to a bare `action` (unconstrained) rather than an `in [...]` list.
- **Resource** — `resource == AgentCore::Gateway::"<default-gateway ARN>"` (one gateway per engine; policies don't need to distinguish resources beyond that).
- **Effect** — `GroupToolGrant.effect == "DENY"` maps to Cedar `forbid` (forbid-wins, matching the existing ALLOW/DENY-wins semantics in `web/lib/tool-permissions.ts`); `"ALLOW"` maps to `permit`.

#273 additionally needs to make the harness call gateway-registered targets (not raw `McpServer` URLs) so the policy engine is actually in the request path — see the "Gateway registration" section of [`docs/agentic-architecture.md`](./agentic-architecture.md) for how `gatewayTargetId` already gets set today via `registerMcpTarget`.
