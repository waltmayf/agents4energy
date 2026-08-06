# MCP Tool Permissions (Cognito Group → Tool Grants)

Tracks who is *supposed* to be able to call which MCP tool. This is the human-editable model from issue #247 — it is **not yet enforced server-side**. Enforcement (Cedar policy generation + gateway routing) is a separate, still-open issue (#248), split into three slices: #271 (policy engine config only), #272 (generate + sync policies from `GroupToolGrant` — this doc's Cedar section), #273 (route tool calls through the gateway so denial is authoritative).

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

## Cedar policy engine

`agent/default/agentcore/agentcore.json` configures a Cedar `policyEngines` entry (`DefaultCedar`, #271) and associates it with `default-gateway` via `policyEngineConfiguration` in `mode: "LOG_ONLY"`. No tool calls are routed through the gateway yet (`web/lib/harness-agent.ts` still calls each `McpServer` URL directly as a `remote_mcp` tool), so the engine has nothing to evaluate in practice. `LOG_ONLY` is a placeholder — it becomes meaningful once #273 routes calls through the gateway, at which point it should move to `ENFORCE`.

`agentcore.json`'s `policyEngines[].policies` array is intentionally **empty** — the live policy set is generated and pushed directly to the deployed engine (see below), not hand-written in this file. Two prior static smoke-test policies (`AdminAllowAllTools`, `DefaultDenyUnauthenticated`) were removed once the generator landed.

> **Important wiring note (#272):** the `AgentCoreApplication` CDK wrapper (`web/amplify/constructs/agentCoreApplication.ts`) previously built a minimal spec for `@aws/agentcore-cdk`'s real construct that read `name`/`memories`/`runtimes` but silently dropped `policyEngines` — so `agentcore.json`'s `DefaultCedar` engine was configured but **never actually synthesized into the deployed CDK stack** (only visible to `agentcore validate`/local CLI iteration). This was fixed alongside the generator; `policyEngines` now flows through to the real construct and `policyEngineArn`/`policyEngineId` accessors were added.

### Generation: `GroupToolGrant` → Cedar (#272)

`web/lib/cedar-policy-generation.ts` (`generateCedarPolicies`) is a pure, unit-tested function mapping each `GroupToolGrant` row to one Cedar policy:

- **Principal** — `principal is AgentCore::OAuthUser` guarded by `principal.getTag("cognito:groups").contains("<group>")`. Because `default-gateway` uses `authorizerType: "CUSTOM_JWT"` (Cognito), every JWT claim becomes a **tag** on the `AgentCore::OAuthUser` principal, readable via `principal.hasTag(...)`/`principal.getTag(...)`.
  - **Correction to the #271 placeholder:** Cognito's `cognito:groups` claim is a **JSON array** of group-name strings (confirmed against AWS's documented ID-token payload shape — `"cognito:groups": ["group-a", "group-b"]`), not a space/comma-joined string. So the tag value is a Cedar `Set<String>`, and the correct membership check is `.contains("<group>")`, **not** `like "*<group>*"` (a `like` string match against a stringified set could false-positive on group-name substrings, e.g. `"eng"` matching inside `"reservoir-eng"`).
- **Action** — `AgentCore::Action::"<targetName>___<toolName>"` for an exact grant (matching the `agentcore add policy -g`/`--target` generated-policy convention, confirmed against the `agentcore` CLI's own policy-generation code), where `targetName` is the tool's registered gateway target name (resolved via `GetGatewayTarget` on the `McpServer`'s `gatewayTargetId` — see "Gateway registration" below). A `GroupToolGrant.toolName == "*"` row maps to a bare `action` (unconstrained) rather than an `in [...]` list.
- **Resource** — `resource is AgentCore::Gateway` (one gateway per engine here; policies don't need to distinguish resources beyond that).
- **Effect** — `GroupToolGrant.effect == "DENY"` maps to Cedar `forbid` (forbid always overrides permit — the same DENY-over-ALLOW semantics `web/lib/tool-permissions.ts` already implements client-side); `"ALLOW"` maps to `permit`.

Every generated policy's `enforcementMode` is `LOG_ONLY`, matching the engine-level mode, and its name is deterministic (`Grant_<group>_<targetName>_<toolName>`, sanitized/hashed to fit Cedar's 48-char `PolicyNameSchema`) so repeated syncs update rather than duplicate.

### Sync mechanism: DynamoDB Stream, not build-time (#272)

`GroupToolGrant` rows are edited at **runtime** via the #247 admin UI (`PermissionsPanel`), not at deploy time — a build-time sync (baked into `agentcore.json` during `agentcore deploy`/CDK synth) would only reflect grants that existed as of the last deploy, silently drifting from the admin UI between deploys. So the sync is a **Lambda triggered by a DynamoDB Stream** on the `GroupToolGrant` table (`web/amplify/functions/sync-cedar-policies`), wired in `backend.ts` behind `if (AGENTCORE_POLICY_ENGINE_ID)`:

1. Any create/update/delete on `GroupToolGrant` fires the stream.
2. The Lambda ignores the stream record's contents and instead **re-scans** every `GroupToolGrant` + `McpServer` row — a full reconcile rather than a diff of one record, so it can't drift after a batch edit, a failed prior invocation, or concurrent writes. Grant edits are an infrequent, admin-only action, so the extra Scan/API calls are an acceptable tradeoff for that guarantee.
3. For each server with a registered `gatewayTargetId`, `GetGatewayTarget` resolves its Cedar `targetName`; grants on an unregistered/stale server are skipped for that round (picked up automatically once the server is (re)registered).
4. `generateCedarPolicies` builds the desired policy set; `web/lib/cedar-policy-sync.ts` (`syncCedarPolicies`) diffs it against `ListPolicies` on the engine and calls `CreatePolicy`/`UpdatePolicy`/`DeletePolicy` — **only** ever touching policies whose name starts with `Grant_` (its own generated-policy prefix), so a future hand-written policy is never deleted by this sync.

### What #273 still needs to do

#273 needs to make the harness call gateway-registered targets (not raw `McpServer` URLs) so the policy engine is actually in the request path, and flip `default-gateway`'s `policyEngineConfiguration.mode` (and each generated policy's `enforcementMode`) from `LOG_ONLY` to `ACTIVE`/`ENFORCE` once policies have been validated in shadow mode. See the "Gateway registration" section of [`docs/agentic-architecture.md`](./agentic-architecture.md) for how `gatewayTargetId` already gets set today via `registerMcpTarget`.
