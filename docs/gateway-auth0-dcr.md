# Swapping Cognito for Auth0 to Enable DCR on the Gateway

**Status: design/runbook only — no CDK or code in this repo implements this yet.** This document walks through what it would take to point the AgentCore Gateway's inbound `CUSTOM_JWT` authorizer at [Auth0](https://auth0.com/) instead of Cognito, so that MCP clients can **self-register** via OAuth **Dynamic Client Registration (DCR, [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591))**. The current CDK assets stay on Cognito; treat this as the migration playbook to reach for when you actually need DCR.

If you only need to point a local Claude Code (or any single HTTP MCP client) at the gateway with a **pre-registered** app client, you do **not** need any of this — see [docs/gateway-oauth-local-clients.md](gateway-oauth-local-clients.md). This doc is specifically for the case where callers cannot be pre-registered.

---

## Why you'd want this

The end goal: let the remote agent (and third-party MCP clients) reach the gateway **without a human pre-provisioning a client ID for each one**. Concretely — an MCP client like `mcp.shop` (WorkOS) that you don't control and can't hand a Cognito app-client ID to. The MCP authorization spec expects a client to *discover* the resource, *register itself* dynamically, then run a PKCE authorization-code flow. That self-registration step is DCR.

**Cognito does not support DCR.** Its only client-creation path is the admin `CreateUserPoolClient` API (see the "Cognito does not support OAuth Dynamic Client Registration" note in [docs/gateway-oauth-local-clients.md](gateway-oauth-local-clients.md)). So every caller must be pre-registered out-of-band and its client ID added to the gateway's `allowedClients` (that is exactly what the `TrustedOAuthClient` table in [docs/gateway-oauth-local-clients.md](gateway-oauth-local-clients.md) automates). DCR removes that manual step, and Cognito can't provide it — you need a DCR-capable authorization server.

## What the gateway does and does not do

The AgentCore Gateway's inbound `CUSTOM_JWT` authorizer is **provider-agnostic**. It is configured with an OIDC `discoveryUrl` (which must match `^.+/\.well-known/openid-configuration$`) plus at least one of `allowedClients`, `allowedAudience`, `allowedScopes`, or `customClaims`. At request time it fetches that discovery document, pulls the JWKS, and validates the incoming bearer JWT's signature and claims against it. AWS's own docs confirm: *"You can also use another OAuth 2.0-compliant authentication provider instead of Cognito."*

Crucially:

- **The gateway does no DCR itself, on either leg.** DCR is a capability of the *authorization server*, not the resource server. The gateway just validates whatever JWT arrives. Swapping the `discoveryUrl` from Cognito to Auth0 is what lets a *DCR-capable* authorization server sit behind the gateway — Auth0 is the piece that actually registers clients.
- **DCR client IDs are dynamic**, so you cannot enumerate them into a static `allowedClients` list. The authorizer must instead validate on **`allowedAudience`** (and optionally `allowedScopes`) — every DCR-registered client requests the same API audience, so audience is the stable trust anchor.

## Prerequisites in Auth0

1. **An Auth0 tenant.** Its issuer base URL is `https://<tenant>.<region>.auth0.com/`; its OIDC discovery URL is `https://<tenant>.<region>.auth0.com/.well-known/openid-configuration`. That URL and the JWKS it points at must be reachable over HTTPS from the gateway's control plane.
2. **Dynamic Client Registration enabled.** Turn on **OIDC Dynamic Application Registration** (tenant setting `enable_dynamic_client_registration`) and, if you want to restrict who can register, **promoted connections** + an **initial access token**/**software statement** policy (see "Trust model" below). With DCR on, Auth0 exposes the `/oidc/register` endpoint that MCP clients hit.
3. **An API (resource server) with an identifier (audience).** Create an Auth0 **API** whose identifier is the audience the gateway will validate on — e.g. `https://gateway.<your-domain>/mcp`. Define the scopes/permissions the MCP tools map to.
4. **A roles/groups claim** for tool governance. Cedar in this repo authorizes off `cognito:groups` (see below) — you'll add an Auth0 **Action** (or rule) that injects a namespaced custom claim such as `https://agents4energy/groups` into the access token, populated from the user's Auth0 roles.

## The swap, step by step

All of the code changes below live in `web/amplify/backend.ts` and `web/amplify/constructs/reconcileGatewayAuthorizer/` — **do not** hand-edit the deployed gateway with `update-gateway`; the reconcile custom resource (see below) would revert it on the next deploy.

### 1. Point the authorizer at Auth0's discovery URL

Today the discovery URL is derived from this stack's own Cognito pool in [web/amplify/backend.ts](../web/amplify/backend.ts):

```ts
// current — Cognito
const cognitoDiscoveryUrl = Fn.join('', [
  'https://cognito-idp.', region, '.amazonaws.com/', userPoolId,
  '/.well-known/openid-configuration',
]);
```

To swap, replace the `discoveryUrl` fed into **both** places that read it:

- the `authorizerConfiguration.customJwtAuthorizer` block in `agentCoreGatewaysWithUniqueNames` (the **create-time** config, ~line 342), and
- the `discoveryUrl` prop passed to `ReconcileGatewayAuthorizer` (the **every-deploy** reconcile, ~line 651).

Point both at `https://<tenant>.<region>.auth0.com/.well-known/openid-configuration` (best sourced from an Amplify `secret()` or SSM parameter, not hardcoded).

### 2. Validate on `allowedAudience`, not `allowedClients`

This is the substantive change. With DCR, client IDs are minted on demand, so the static `allowedClients: [browserClient, serviceWebhookClient]` list can't work. Change the authorizer config from:

```ts
customJwtAuthorizer: {
  discoveryUrl: cognitoDiscoveryUrl,
  allowedClients: [browserClient.userPoolClientId, serviceWebhookUserPoolClient.ref],
}
```

to audience-based validation:

```ts
customJwtAuthorizer: {
  discoveryUrl: auth0DiscoveryUrl,
  allowedAudience: ['https://gateway.<your-domain>/mcp'], // the Auth0 API identifier
  // optionally: allowedScopes: ['mcp:invoke']
}
```

> ⚠️ **The reconcile handler will fight you if you skip this.** `ReconcileGatewayAuthorizer` (`web/amplify/constructs/reconcileGatewayAuthorizer/`) runs `GetGateway` → compares `discoveryUrl`/`allowedClients` against its desired set → `UpdateGateway` on **every deploy and on every `TrustedOAuthClient` table change** (issues #328/#418). It currently only knows how to reconcile `discoveryUrl` + `allowedClients`. If you change the create-time config to Auth0 + `allowedAudience` but leave the reconcile handler computing a Cognito discovery URL and an `allowedClients` union, the next deploy (or the next `TrustedOAuthClient` write) will **clobber your Auth0 authorizer straight back to Cognito**. You must update `reconcile.ts`/`handler.ts` to (a) derive the Auth0 discovery URL and (b) reconcile `allowedAudience` instead of / in addition to `allowedClients`. See [docs/gateway-oauth-local-clients.md](gateway-oauth-local-clients.md) for how that reconcile loop works.

### 3. Deal with the callers that ride this authorizer today

The gateway authorizer is shared by more than external MCP clients — swapping it affects each:

- **Browser callers.** The app authenticates users with Cognito, and the ClaudeCode runtime relays the user's **Cognito access token** to the gateway (#339, and the access-token-not-ID-token requirement in #327). Once the gateway validates against Auth0, a Cognito-issued token is rejected. You must either (a) move browser login to Auth0 (or federate Cognito as an upstream connection into Auth0 so the app can obtain Auth0 tokens for gateway calls), or (b) keep internal callers on a **separate** Cognito-backed gateway and stand Auth0 up on a **second gateway dedicated to DCR clients** (see "Alternative" below).
- **The `service-webhook` machine identity (#340).** Today it mints a Cognito token via `USER_PASSWORD_AUTH` against a dedicated app client with a >3h `AccessTokenValidity`. Under Auth0 this becomes an Auth0 **Machine-to-Machine application** using the `client_credentials` grant against the same API audience. Its long-lived-token concern (a Claude Code run can last hours; the http MCP transport has no mid-run refresh) carries over — set the Auth0 token lifetime accordingly.
- **The `TrustedOAuthClient` table.** Its whole purpose is unioning extra Cognito app-client IDs into `allowedClients` and callback URLs onto the Cognito app client. Under audience-based Auth0 validation, DCR makes per-client allow-listing unnecessary, so this table becomes Cognito-specific dead weight on the DCR gateway (still relevant if you keep a Cognito gateway around per the alternative).

### 4. Remap Cedar tool governance off `cognito:groups`

Tool authorization (the permissions panel at `/agents`, `GroupToolGrant` rows, the `SyncCedarPolicies` construct) keys off the `cognito:groups` claim. Auth0 tokens won't carry that claim. Add an Auth0 Action to emit a namespaced groups claim (e.g. `https://agents4energy/groups`) and update the Cedar principal/tag mapping to read it. Until this is done, every tool call will fail closed (no group match → no grant).

### 5. The resulting MCP client flow

Once the gateway trusts Auth0, a spec-compliant MCP client self-onboards with no manual provisioning:

1. Client calls the gateway's protected-resource metadata ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728), served at `/.well-known/oauth-protected-resource`) → learns the authorization server is Auth0.
2. Client reads Auth0's authorization-server metadata ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)) → finds the `/oidc/register` (DCR) endpoint.
3. Client **registers itself** via DCR ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)), receiving a fresh `client_id` (Auth0 also supports [RFC 7592](https://datatracker.ietf.org/doc/html/rfc7592) client update).
4. Client runs a PKCE authorization-code flow against Auth0, requesting the gateway API audience.
5. Client presents the resulting access token to the gateway; the authorizer validates it on audience + signature. Because the client registered *itself*, no admin ever touched `allowedClients`.

## Trust model: DCR is more open than pre-registration

Static `allowedClients` is an explicit allow-list — nothing you didn't name gets in. DCR inverts that: **any** client that can reach `/oidc/register` can mint a `client_id`. That's the point (self-service), but it widens the surface. Tighten it back down with Auth0's controls:

- **Initial access tokens / software statements** — require a signed [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) software statement or an initial access token to register, so registration isn't fully anonymous.
- **Audience + scope as the real gate** — a registered client still gets nothing until a *user* completes the authorization-code flow and consents; the access grant, not the registration, is where authorization actually happens. Keep scopes narrow and map them to Cedar grants.
- **Promoted connections** — constrain which identity providers a DCR client may authenticate users against.

## Alternative: a second, DCR-only gateway

If disrupting the working Cognito-based internal auth is unattractive, stand up a **second** AgentCore Gateway whose authorizer points at Auth0 with `allowedAudience`, and leave the primary gateway on Cognito for browser + webhook callers. External DCR clients target the Auth0 gateway; internal traffic is untouched. This sidesteps steps 3's browser/webhook migration entirely at the cost of running two gateways (and two authorizer reconcile paths).

## What this does NOT change

Outbound auth — the agent calling a *third-party* MCP server that requires OIDC — is a separate mechanism and is unaffected. That path is the `McpServer` row (`OAUTH_3LO` + `CUSTOM` vendor) → `sync-oauth-credential-provider` creates a `CustomOauth2` credential provider → `register-mcp-target-stream` attaches it as a gateway target, with per-user consent via the elicitation banner. See [docs/gateway-to-gateway-federation.md](gateway-to-gateway-federation.md) for the outbound/federation runbook. Note that outbound has **no** DCR either — creating a `CustomOauth2` provider requires a pre-issued `clientId`/`clientSecret` from the third party.

## Rollback

Because the change is entirely in `backend.ts` + the reconcile handler, reverting is a redeploy: restore the `cognitoDiscoveryUrl` + `allowedClients` config and the reconcile handler's Cognito logic, then `pnpm deploy`. The reconcile custom resource issues an `UpdateGateway` on the next deploy that puts the live gateway back on Cognito.

## Related

- [docs/gateway-oauth-local-clients.md](gateway-oauth-local-clients.md) — the current Cognito, pre-registered-client model and the `TrustedOAuthClient` runtime-trust table.
- [docs/gateway-to-gateway-federation.md](gateway-to-gateway-federation.md) — outbound 3LO federation (agent → another gateway/MCP server).
- [docs/agentic-architecture.md](agentic-architecture.md) — full data flow, memory scoping, and the two-halves (AgentCore + Amplify) model.
