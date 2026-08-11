# Per-user MCP tool governance

**AgentCore Identity + a Cedar policy engine decide which signed-in user can
call which MCP tool** — enforced authoritatively at the gateway, not just hidden
in the UI. This is the top-level overview for the governance epic (#245/#248);
the two companion docs go deeper:

- [`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md) — the data model
  (`GroupToolGrant`), the admin UI, the client-side (UX-only) filtering, and how
  Cedar policies are generated and synced.
- [`docs/cedar-enforce-demo.md`](./cedar-enforce-demo.md) — a captured, live
  DENY → ALLOW transcript, plus the two bugs (#325) that had to be fixed before
  `ENFORCE` mode worked at all.

## The identity model

1. A user signs in via Cognito and belongs to zero or more **Cognito groups**
   (`admin`, `reservoir-eng`, `drilling` — see `web/amplify/auth/resource.ts`).
   The group membership rides in the JWT as the `cognito:groups` claim.
2. `default-gateway` uses a `CUSTOM_JWT` authorizer (Cognito). It requires the
   caller's Cognito **access token** as `Authorization: Bearer` (the ID token is
   rejected with HTTP 403 `insufficient_scope`, #327). AgentCore surfaces every
   JWT claim as a **tag** on the `AgentCore::OAuthUser` principal, so Cedar can
   read `cognito:groups` via `principal.getTag("cognito:groups")`.

## The permission model

Admins express intent as flat `GroupToolGrant` rows — `(group, mcpServerId,
toolName, effect)` — via the **Permissions** tab on `/agents`. A server is
**ungoverned** (every tool visible to everyone) until its first grant row
exists; after that, access follows the ALLOW/DENY rows for the user's groups
(DENY wins over ALLOW; `"*"` matches every tool). Full detail:
[`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md#data-model).

## How a grant becomes enforcement

```
Admin edits GroupToolGrant (admin UI)
        │  DynamoDB stream
        ▼
sync-cedar-policies Lambda  ──►  generateCedarPolicies()  ──►  Cedar policy engine
 (full reconcile of all rows)     (web/lib/cedar-policy-generation.ts)   (DefaultCedar, ENFORCE)
```

Each grant maps to one Cedar policy pinned to the concrete gateway and the
tool's registered target: `action == AgentCore::Action::"<target>___<tool>"`,
`resource == AgentCore::Gateway::"<gatewayArn>"`, guarded by a string match on
the `cognito:groups` tag. ALLOW → `permit`, DENY → `forbid`. The sync runs on
every grant edit (DynamoDB stream), so runtime admin-UI changes take effect
without a redeploy. Generation/sync detail:
[`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md#cedar-policy-engine).

## The enforced request path

Tool calls flow **through** the gateway (not direct to the MCP server URL) so
Cedar can evaluate each one:

```
harness/agent  ──►  default-gateway (/mcp, CUSTOM_JWT)  ──►  Cedar engine (ENFORCE)  ──►  target Lambda/MCP server
   tools/call        access token as Bearer                  permit? forbid? default-deny
```

A server is routed through the gateway whenever it has a `gatewayTargetId`
(`routeThroughGateway` in both `web/lib/harness-agent.ts` and
`web/amplify/functions/invoke-agent/handler.ts`), with the caller's Cognito
access token attached. A call with no applicable `permit` is **denied by
default** — JSON-RPC `-32002` "Tool Execution Denied … policy enforcement".

## Demo: two users, same agent, different tools

The scripted single-user version is
[`scripts/cedar-enforce-demo.ts`](../scripts/cedar-enforce-demo.ts)
(`npx tsx scripts/cedar-enforce-demo.ts`) — it captures a real DENY → ALLOW for
one user+tool. To show two groups diverging on the *same* agent:

1. **Two users, two groups.** Put user A in `reservoir-eng` and user B in
   `drilling` (Cognito console or `admin-add-user-to-group`). Assign both the
   same agent — one whose tools include a gateway-registered server (e.g. the
   seeded **S3 Filesystem Tools**, target `s3-tools-…`).
2. **Grant one group.** In the **Permissions** tab, add
   `ALLOW reservoir-eng → S3.ReadFile`. Leave `drilling` with no grant.
3. **User A (granted) calls `ReadFile`** through the gateway → **ALLOWED**
   (a `result`; a tool-level "File not found" still means Cedar let the call
   reach the Lambda):
   ```json
   {"jsonrpc":"2.0","id":1,"result":{"isError":false,"content":[{"type":"text","text":"{\"error\":\"File not found: …\"}"}]}}
   ```
4. **User B (not granted) calls the same tool** → **DENIED** at the gateway,
   before the Lambda runs:
   ```json
   {"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]"}}
   ```
5. **In the chat UI**, the same effect is visible without calling: the
   client-side filter (`web/lib/tool-permissions.ts`) hides the S3 server's tools
   from user B's tool list while showing them to user A — a UX convenience layered
   on top of the authoritative gateway enforcement.

The exact commands (get an access token, resolve `<target>___<tool>`, `curl` the
gateway, add/remove the grant, watch the policy converge) are in
[`docs/cedar-enforce-demo.md`](./cedar-enforce-demo.md#reproducing-it).

## Related issues

Epic #245 / #248. Slices: #271 (engine config), #272 (generate + sync), #279
(route through gateway), #280 (flip to `ENFORCE`), #325 (two ENFORCE bugs),
#327 (forward the access token).
