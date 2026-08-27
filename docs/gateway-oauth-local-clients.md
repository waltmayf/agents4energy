# Connecting a local MCP client (Claude Code) to the gateway over OIDC

This doc shows how to point a **local Claude Code** (or any standards-compliant
remote-MCP client) at the AgentCore **`default-gateway`** using the gateway's
built-in OIDC/OAuth mechanism — and how that same mechanism lets you expose one
shared set of MCP tools to many users while gating individual tools by the
signed-in user's **subscription tier**.

It ties together two mechanisms documented separately:

- [`docs/mcp-server-integration.md`](./mcp-server-integration.md) — the OAuth2 /
  OIDC discovery + PKCE flow the gateway serves (written from the web app's
  perspective; the gateway side is client-agnostic).
- [`docs/tool-governance.md`](./tool-governance.md) — per-group tool enforcement
  at the gateway via Cedar, keyed off the `cognito:groups` JWT claim.

> **TL;DR.** The gateway is a spec-compliant OAuth 2.0 protected resource
> (RFC 9728 + PKCE). Claude Code discovers the Cognito authorization server from
> the gateway, runs the browser sign-in, and stores its own per-user access
> token. Every `tools/call` carries that token; the gateway's Cedar engine reads
> `cognito:groups` from it and allows/denies each tool. Model a group as a tier
> (`free` / `pro` / `enterprise`) and you have tier-gated MCP tools with zero
> client-side secrets.

---

## Why this works out of the box

The main Cognito app client was deliberately configured for this exact client
(`web/amplify/backend.ts`, added for #298):

```ts
// Hosted-UI domain + authorization-code OAuth flow on the existing app client
// (#298), so a standard HTTP MCP client (e.g. Claude Code's `type: "http"` +
// `oauth: { clientId, callbackPort }` config) can complete the PKCE handshake
// against default-gateway. The gateway's CUSTOM_JWT authorizer already trusts
// this pool/client (see allowedClients above) — no gateway change needed.
```

Concretely, the deploy sets up on the primary user-pool client:

| Setting | Value | Source |
|---------|-------|--------|
| OAuth flow | Authorization Code + PKCE (`code`) | `backend.ts` `allowedOAuthFlows = ['code']` |
| Scopes | `openid`, `email`, `profile` | `backend.ts` `allowedOAuthScopes` |
| IdP | `COGNITO` (Hosted UI) | `backend.ts` `supportedIdentityProviders` |
| Hosted-UI domain | derived from the stack name | `CognitoHostedUiDomain` |
| Registered callback | `http://localhost:8080/callback` | `mcpOauthCallbackUrl` |
| Registered logout | `http://localhost:8080` | `mcpOauthLogoutUrl` |

And the gateway's `CUSTOM_JWT` authorizer already **trusts this app client** —
`allowedClients` includes `backend.auth.resources.userPoolClient` and the
authorizer's `discoveryUrl` points at this stack's live pool
(`web/amplify/backend.ts`, reconciled on every deploy by
`ReconcileGatewayAuthorizer`, #328). So **no gateway change is needed** to add a
local client — it just has to authenticate against that pool/client.

> The registered callback is `localhost:**8080**/callback`, so configure Claude
> Code with **`callbackPort: 8080`**. If you use a different port you must add
> that callback URL to the app client first (see
> [Registering a different callback port](#registering-a-different-callback-port)).

---

## Current deployment values

Read these from `web/amplify_outputs.json` — they change per deploy, so treat
the table as an example, not a constant:

```bash
jq '{
  gateway: .custom.agentcore_gateway_endpoint,
  region:  .auth.aws_region,
  userPool: .auth.user_pool_id,
  appClient: .auth.user_pool_client_id
}' web/amplify_outputs.json
```

Example (main deploy at time of writing):

| Property | Value |
|----------|-------|
| Gateway MCP endpoint | `https://default-default-gateway-web-main-r7mcr35dot.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp` |
| Region | `us-east-1` |
| App client ID | `7uo4jck2flu2pnn3trmuntksti` |

> ⚠️ AgentCore MCP endpoints are path-sensitive. Use the endpoint exactly as
> published in `amplify_outputs.json`. The gateway serves the OAuth metadata at
> `<origin>/.well-known/oauth-protected-resource`.

---

## Setup: add the gateway to local Claude Code

Claude Code speaks the remote-MCP OAuth flow natively. Add the gateway as an
HTTP MCP server pinned to the trusted app client and the registered callback
port:

```bash
GATEWAY=$(jq -r .custom.agentcore_gateway_endpoint web/amplify_outputs.json)
CLIENT=$(jq -r .auth.user_pool_client_id web/amplify_outputs.json)

claude mcp add --transport http a4e-gateway "$GATEWAY" \
  --oauth-client-id "$CLIENT" \
  --oauth-callback-port 8080
```

> Flag names vary slightly across Claude Code versions; the invariants that
> matter are: **transport `http`**, the **client ID** = the trusted app client
> from `amplify_outputs.json`, and the **callback port** = `8080` (the
> registered redirect). Run `claude mcp add --help` for your version's exact
> spelling, or add it to `~/.claude.json` / `.mcp.json` directly:
>
> ```json
> {
>   "mcpServers": {
>     "a4e-gateway": {
>       "type": "http",
>       "url": "https://default-default-gateway-web-main-r7mcr35dot.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
>       "oauth": { "clientId": "7uo4jck2flu2pnn3trmuntksti", "callbackPort": 8080 }
>     }
>   }
> }
> ```

Then authenticate. In a Claude Code session run `/mcp`, pick `a4e-gateway`, and
choose **Authenticate**. Claude Code will:

1. `GET <gateway>/.well-known/oauth-protected-resource` → discover the Cognito
   authorization server.
2. `GET <authorization-server>/.well-known/openid-configuration` → find the
   Hosted-UI `authorization_endpoint` and `token_endpoint`.
3. Generate a PKCE verifier + `S256` challenge and open the Cognito Hosted-UI
   sign-in in your browser.
4. Redirect to `http://localhost:8080/callback`, exchange the code for tokens at
   `token_endpoint`, and store them locally (per-user, never shared).

After sign-in, `/mcp` shows the gateway's tool catalog — filtered to what your
tier is allowed to call (see below). The token refreshes automatically via the
stored refresh token.

---

## The token, the claim, and the tier

The gateway requires the Cognito **access token** as
`Authorization: Bearer <token>` — the **ID token is rejected** with HTTP 403
`insufficient_scope` (#327). Claude Code sends the access token by default.

A user belongs to zero or more **Cognito groups**, declared in
`web/amplify/auth/resource.ts` (currently `admin`, `reservoir-eng`, `drilling`,
`service-webhook`). Group membership rides in the access token as the
`cognito:groups` claim, and AgentCore surfaces every JWT claim as a **tag** on
the `AgentCore::OAuthUser` principal — so Cedar can read it via
`principal.getTag("cognito:groups")`.

**To gate features by subscription tier, model each tier as a Cognito group.**
For a SaaS product sharing MCP tools with customers, add groups like `free`,
`pro`, `enterprise` to `web/amplify/auth/resource.ts`, put each customer in the
group matching their plan (Cognito console, `admin-add-user-to-group`, or your
billing webhook), and the tier travels in every token automatically.

---

## Gating tools by tier (Cedar)

A server routed through the gateway is **ungoverned** (every tool visible to
everyone) until its first `GroupToolGrant` row exists. After that, access
follows the ALLOW/DENY rows for the caller's groups — **DENY wins over ALLOW**,
`"*"` matches every tool, and a call with no applicable `permit` is **denied by
default**. Grants are authored in the **Permissions** tab on `/agents`; a
DynamoDB stream runs `sync-cedar-policies`, which regenerates the Cedar policy
set (no redeploy). Full detail:
[`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md) and
[`docs/tool-governance.md`](./tool-governance.md).

Example — expose one tool to paid tiers only:

| Group (tier) | Grant | Effect |
|--------------|-------|--------|
| `enterprise` | `ALLOW <server> → *` | all tools |
| `pro` | `ALLOW <server> → PremiumTool` | just that tool |
| `free` | *(no grant)* | denied by default → tool hidden/blocked |

Enforcement is authoritative at the gateway, not just a UI nicety: a call to a
tool the tier isn't granted returns

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"Tool Execution Denied: Tool call not allowed due to policy enforcement [No policy applies to the request (denied by default).]"}}
```

before the target Lambda/MCP server ever runs. A local Claude Code client sees
exactly this — the tool simply isn't callable for that user. See
[`docs/cedar-enforce-demo.md`](./cedar-enforce-demo.md) for a captured
DENY → ALLOW transcript and the exact `curl` reproduction.

---

## The full request path

```
Local Claude Code
  │  (one-time) OAuth discovery + PKCE against Cognito Hosted UI  ──►  stores per-user access token
  │
  ▼  tools/call  +  Authorization: Bearer <access token>
default-gateway (/mcp, CUSTOM_JWT authorizer — trusts this app client)
  │
  ▼  reads cognito:groups tag on AgentCore::OAuthUser
Cedar engine (ENFORCE, deny-by-default)
  │  permit? forbid?
  ▼
target Lambda / MCP server
```

No secret ever lives in the client config — only a public app client ID. Each
user gets their own token, their own tier, and their own tool set.

---

## Registering a different callback port

Only `http://localhost:8080/callback` is registered on the app client
(`mcpOauthCallbackUrl` in `web/amplify/backend.ts`). If a client needs a
different loopback port, add its callback URL to the client's callback list and
redeploy:

```ts
// web/amplify/backend.ts — merge, don't replace
const extraCallbacks = ['http://localhost:8080/callback', 'http://localhost:33418/callback'];
cfnUserPoolClient.callbackUrLs = Array.from(new Set([...existingCallbackUrls, ...extraCallbacks]));
```

Cognito does **not** support OAuth Dynamic Client Registration, so the client ID
must be a pre-registered app client that the gateway's `allowedClients` trusts —
you can't have Claude Code register a fresh client on the fly. Use the primary
app-client ID from `amplify_outputs.json`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Sign-in redirect fails / "redirect_uri mismatch" | Client's callback port isn't registered | Use `callbackPort: 8080`, or register your port (above) |
| Browser lands on `cognito-idp.<region>.amazonaws.com/authorize` and gets `BadRequest` | Gateway advertises a dead/stale pool; discovery falls back to the control-plane host | Redeploy (runs `ReconcileGatewayAuthorizer`), or repair with `update-gateway`. Full diagnosis: [`docs/mcp-server-integration.md`](./mcp-server-integration.md#troubleshooting-gateway-authorize-request-returns-badrequest) |
| Every tool call returns 403 `insufficient_scope` | Client is sending the **ID** token, not the access token (#327) | Ensure the client sends the Cognito **access** token as the Bearer |
| A tool you expect is missing / `-32002` denied by default | No `GroupToolGrant` ALLOW for your group, or a DENY wins | Add an ALLOW grant for your tier in the **Permissions** tab |
| Tools appear ungoverned (everyone sees everything) | The server has **no** grant rows yet | Add the first `GroupToolGrant` row to switch it into governed mode |

Verify the discovery chain by hand:

```bash
GW=$(jq -r .custom.agentcore_gateway_endpoint web/amplify_outputs.json | sed 's#/mcp$##')
curl -s "$GW/.well-known/oauth-protected-resource" | jq .authorization_servers
AS=$(curl -s "$GW/.well-known/oauth-protected-resource" | jq -r '.authorization_servers[0]')
curl -s "$AS/.well-known/openid-configuration" | jq '{authorization_endpoint, token_endpoint}'
```

`authorization_endpoint` should be on the Cognito **Hosted-UI** domain
(`https://<prefix>.auth.<region>.amazoncognito.com/oauth2/authorize`), not the
`cognito-idp.*` control-plane host.

---

## Related

- [`docs/mcp-server-integration.md`](./mcp-server-integration.md) — OAuth/OIDC
  requirements and the in-app browser flow.
- [`docs/tool-governance.md`](./tool-governance.md) — governance overview.
- [`docs/mcp-tool-permissions.md`](./mcp-tool-permissions.md) — `GroupToolGrant`
  data model, admin UI, Cedar generation/sync.
- [`docs/cedar-enforce-demo.md`](./cedar-enforce-demo.md) — live DENY → ALLOW
  demo and `curl` reproduction.
- Issues: #298 (Hosted-UI OAuth for HTTP MCP clients), #328/#128 (authorizer
  reconciliation), #327 (access-token requirement), #245/#248 (governance epic).
