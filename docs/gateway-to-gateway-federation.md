# Gateway-to-Gateway OAuth (3LO) Federation

This is the deploy-twice runbook for the outbound-OAuth capstone of epic #412: making
**one AgentCore deployment call a second, independent deployment's `/mcp` gateway as a
3-legged-OAuth (3LO) MCP target**, where each user authenticates in a browser and their
per-user token is vaulted by AgentCore Identity and injected outbound on every tool call.

Two deployments are involved throughout:

- **Deployment A** — the *caller*. Its harness/agent invokes a tool; A's gateway holds a
  `CustomOauth2` (or `GoogleOauth2`) credential provider and injects the calling user's
  vaulted token when it forwards the `tools/call` to B.
- **Deployment B** — the *callee*. Its `/mcp` gateway is registered as a 3LO target of A.
  B validates the incoming token against **B's** Cognito pool and Cedar-gates the call by
  **B's** `cognito:groups`.

If you only need to trust a second deployment's *inbound* caller (add B's app-client id to
A's gateway `allowedClients`, or add a redirect URI to A's hosted UI) without a redeploy,
that lower layer is [`docs/gateway-oauth-local-clients.md`](gateway-oauth-local-clients.md)
(`TrustedOAuthClient`). This doc builds the *outbound* "A calls B" flow on top of it.

---

## The two-identity model (read this first)

Federation deliberately keeps two identities separate. Getting this wrong is the most
common source of confusion:

1. **The A-pool identity** signs into deployment A's frontend (A's Cognito). This is who
   is chatting; it decides which A-side agent/tools they see and gates A's own gateway.
2. **The B-pool identity** is who the user logs in as *in the consent popup* during the
   3LO flow — a **separate** login against **B's** Cognito Hosted UI. AgentCore Identity
   vaults the resulting B token keyed to the A-pool user, and the gateway replays it
   outbound to B.

Therefore **authorization of the federated tool call is governed entirely by B**: B's
Cedar policies evaluate the **B-pool** user's `cognito:groups` (see
[`docs/tool-governance.md`](tool-governance.md)). A user who is `admin` in A but has no
groups in B gets B's default-deny. The A-side grants are irrelevant to what B allows.

**It is the access token, not the ID token, that federates (#327).** B's gateway uses a
`CUSTOM_JWT` authorizer and requires the caller's Cognito **access token** as
`Authorization: Bearer`; an ID token is rejected with HTTP 403 `insufficient_scope`. When
you configure A's credential provider and B's app client, make sure the flow yields an
access token carrying `cognito:groups` (Cognito surfaces every JWT claim as a tag on the
`AgentCore::OAuthUser` principal, which is how B's Cedar reads the group).

---

## Prerequisites

- Two deployed stacks (A and B), each with a working AgentCore gateway. A quick way to get
  B is a second branch/sandbox deploy of this same repo; any OIDC-protected MCP server
  works, but a second copy of *this* app is the canonical test because it already exposes a
  Cedar-gated `/mcp`.
- Admin access to **B's** Cognito user pool (to create/edit an app client and its Hosted-UI
  domain) and to **A's** account (to create a Secrets Manager secret and the credential
  provider — the latter is created for you by saving the `McpServer` row, see below).
- The **B-pool** test user should be a member of at least one `cognito:groups` value that a
  `GroupToolGrant` in B permits for the tool you'll call (otherwise every federated call
  correctly returns default-deny and you can't tell federation apart from a Cedar deny).

---

## Wiring, end to end

### 1. In deployment B — expose an OIDC-protected `/mcp` with a Hosted-UI app client

1. In B's Cognito user pool, create (or reuse) an **app client** configured for
   **Authorization Code grant + PKCE** (`response_type=code`, `code_challenge_method=S256`).
   A client secret is optional for the browser leg but **is** needed by A's credential
   provider (below), so create the client *with* a secret and store that secret in A.
2. Give B's user pool a **Hosted-UI domain** (`https://<prefix>.auth.<region>.amazoncognito.com`).
   This is mandatory: the OIDC `authorization_endpoint` must live on the Hosted-UI domain,
   **not** the `cognito-idp.<region>.amazonaws.com` control-plane host — see the #328 warning
   in step 3 and in [`docs/mcp-server-integration.md`](mcp-server-integration.md).
3. Trust A's inbound caller if needed. B's `/mcp` gateway only accepts a bearer token from
   an app client in its `allowedClients`. Add B's own app client from step 1 to that list
   the data-driven way — create a `TrustedOAuthClient` row in **B** with that `clientId`
   (see [`docs/gateway-oauth-local-clients.md`](gateway-oauth-local-clients.md)); the
   reconcile handler unions it onto B's live gateway within seconds, no redeploy.

### 2. In deployment A — create the credential provider (via the MCP Servers UI)

On A's **Agents → MCP Servers** tab, create a new server pointing at B's `/mcp`:

| Field | Value |
|---|---|
| URL | `https://<B-gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp` |
| Outbound auth type | **OAuth 3-legged (per-user vaulted token)** (`OAUTH_3LO`) |
| Vendor | **Custom (OIDC discovery)** (`CUSTOM`) |
| Discovery URL | B's **Hosted-UI** OIDC discovery URL (see the warning below) |
| Client ID | B's app-client id from step 1 |
| Client secret | A Secrets Manager ARN (in A) whose value is `{ "clientSecret": "<B app-client secret>" }` |
| Scopes | `openid` (plus any B requires) |
| Return URL | A's `https://<A-app-origin>/oauth/agentcore-callback` |

> **⚠️ Discovery URL must be the Hosted-UI issuer, not the control plane (#328).** Cognito
> advertises its OIDC issuer as `https://cognito-idp.<region>.amazonaws.com/<poolId>`, whose
> `authorization_endpoint` is the control-plane API — which has **no** `/authorize` op and
> returns `BadRequest`. Point the Discovery URL at the issuer whose
> `.well-known/openid-configuration` resolves to a `*.auth.<region>.amazoncognito.com/oauth2/authorize`
> endpoint. If B's OIDC doc shows an `authorization_endpoint` on the `cognito-idp.*` host,
> the flow will fail exactly as documented in
> [`docs/mcp-server-integration.md`](mcp-server-integration.md#troubleshooting-gateway-authorize-request-returns-badrequest).

Saving this row makes the `sync-oauth-credential-provider` stream handler call
`CreateOauth2CredentialProvider` (a `CustomOauth2` provider) and write back two read-only
fields onto the row:

- `oauthProviderArn` — the provider's ARN, later attached to the gateway target.
- `oauthCallbackUrl` — the AgentCore-issued callback,
  `https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/<uuid>`.

### 3. Close the loop — register B's callback URL, then register B as A's 3LO target

1. **Add A's provider `oauthCallbackUrl` to B's app-client callback list.** Copy the
   `oauthCallbackUrl` read-back from the row (the panel shows a copy button) and add it as an
   authorized redirect URI on B's app client from step 1. Consent cannot complete until B
   will redirect the code back to AgentCore's callback.
2. **Register B's `/mcp` as a 3LO gateway target of A (slice 3).** Once `oauthProviderArn`
   is populated, the `register-mcp-target-stream` handler attaches the provider to a gateway
   target via `credentialProviderConfigurations` (OAUTH) — this is what makes A's gateway
   inject the vaulted token outbound when forwarding `tools/call` to B.

### 4. Per-user consent (runtime, no redeploy)

The first time an A user asks an agent to call a B tool, B's gateway returns the MCP
`-32042` "requires more information" elicitation because no token is vaulted yet for that
user. In A's chat UI, `McpElicitationBanner` (slices 4/5) surfaces an **Authenticate**
button that opens B's Hosted-UI consent popup; after the user signs in **as a B-pool
identity** and AgentCore redirects back to `/oauth/agentcore-callback`, the token is vaulted
and the original tool call is retried automatically. From then on, that user's B calls are
Cedar-gated by their B groups with no further prompts (until the vaulted token expires).

---

## Let the app self-register — Dynamic Client Registration (RFC 7591)

Steps 2–3 above assume an operator has already obtained a `client_id`/`client_secret` from
the third party and pasted them into the row + a Secrets Manager secret. When the external
authorization server supports **Dynamic Client Registration** ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591))
— e.g. an Auth0-backed gateway (see [`docs/gateway-auth0-dcr.md`](gateway-auth0-dcr.md)),
WorkOS/`mcp.shop`, or any OIDC AS that advertises a `registration_endpoint` — the app can
**self-register** and that manual step disappears. It stays fully stream-driven and requires
**no redeploy** (issue #449).

**How to turn it on.** On the `McpServer` row set `oauthDynamicRegistration = true` (and
`oauthDiscoveryUrl` to the AS's `.well-known/openid-configuration`), and leave `oauthClientId`
empty. Optionally set `oauthRegistrationEndpoint` (to skip discovery), `oauthClientName`,
`oauthSoftwareStatement`, and `oauthInitialAccessTokenArn` (a Secrets Manager ARN, under the
`mcp-oauth-client-secret/` prefix, holding `{ "initialAccessToken": "…" }` for ASes that
require a Bearer token to register). The `sync-oauth-credential-provider` stream handler then
runs the **provider-first + Update** flow automatically:

1. Ensures a placeholder client-secret secret exists and **creates the `CustomOauth2`
   credential provider with a placeholder `client_id`** — solely to obtain AgentCore's
   per-provider `oauthCallbackUrl` (the chicken-and-egg breaker: the AS needs a redirect URI
   at registration time, and that URI is AgentCore's callback, which only exists once the
   provider does).
2. Resolves the `registration_endpoint` from discovery (or the explicit field).
3. `POST`s the RFC 7591 registration with `redirect_uris=[callbackUrl]`,
   `grant_types=["authorization_code"]`, the requested scopes, and the optional
   `initial_access_token`/`software_statement`.
4. Stores the issued `client_secret` in Secrets Manager as `{ "clientSecret": "…" }` and
   writes `oauthClientId` / `oauthClientSecretArn` (plus the RFC 7592 bookkeeping fields
   `oauthRegistrationClientUri` / `oauthRegistrationAccessTokenArn`) back onto the row.
5. `UpdateOauth2CredentialProvider` swaps the placeholder `client_id` for the real one.

From there the row is indistinguishable from a manually-configured one: `oauthProviderArn` is
set, `register-mcp-target-stream` attaches the gateway target (step 3.2 above), and per-user
consent (step 4) proceeds unchanged. The flow is **idempotent** — a row that already has
`oauthClientId` is skipped, and a retried stream batch reuses the existing provider. On
failure the row is left with a visible `oauthError` string (not a half-created provider — the
placeholder is cleaned up). On row deletion the handler does a best-effort RFC 7592 `DELETE`
of the dynamic registration (never blocking deletion on it).

> **You still complete step 3.1 only if the AS requires it.** DCR registers AgentCore's
> callback URL as a redirect URI for you; no manual copy-paste into the AS is needed.

See also [`docs/gateway-auth0-dcr.md`](gateway-auth0-dcr.md) for the **inbound** side —
configuring *our* gateway to trust DCR clients via Auth0.

---

## Google Drive example (`GoogleOauth2` vendor)

The same outbound-3LO machinery federates to non-Cognito IdPs. For Google-protected MCP
servers, select **Vendor = Google (fixed endpoints)** (`GOOGLE`) instead of Custom. Google's
authorization/token endpoints are fixed, so the `GoogleOauth2` provider needs **no discovery
URL** — leave it blank. You supply:

| Field | Value |
|---|---|
| Vendor | **Google (fixed endpoints)** (`GOOGLE`) |
| Client ID | Google OAuth 2.0 **Web application** client id (from Google Cloud Console → APIs & Services → Credentials) |
| Client secret | A Secrets Manager ARN (in A) whose value is `{ "clientSecret": "<Google client secret>" }` |
| Scopes | e.g. `openid email https://www.googleapis.com/auth/drive.readonly` |
| Return URL | A's `https://<A-app-origin>/oauth/agentcore-callback` |

Then, as in step 3, copy the issued `oauthCallbackUrl` read-back into the Google client's
**Authorized redirect URIs**.

**Drive-scope caveats (restricted scopes & verification):**

- `https://www.googleapis.com/auth/drive` and `.../auth/drive.readonly` are Google
  **restricted** scopes. An app requesting them for external users must pass Google's OAuth
  app verification (including a security assessment) or every consent screen shows the
  "unverified app" interstitial and access is capped at a small number of test users.
- While the app is in **Testing** publishing status, only accounts you add as **Test users**
  on the OAuth consent screen can complete the flow, and refresh tokens are short-lived
  (~7 days) — so a vaulted Drive token will need periodic re-consent.
- Prefer the narrowest scope that works (`drive.file` — per-file access the user picks — is
  a **non**-restricted alternative to `drive.readonly` for many use cases and avoids the
  verification burden).
- Google's consent still governs a **Google identity**, exactly mirroring the two-identity
  model above: the tool call runs as the Google user who consented, independent of the A-pool
  login.

---

## End-to-end test (`web/e2e/gateway-federation.spec.ts`)

`web/e2e/gateway-federation.spec.ts` exercises the full flow against a live deployment B. It
**skips cleanly** (with a stated reason) whenever `GATEWAY_B_MCP_URL` is unset — a normal CI
run has no deployment B — so it is safe in the default suite. When the env is present it
drives: create the outbound-3LO server in A → trigger a B tool call → assert the `-32042`
elicitation banner → sign in at B's Hosted UI → assert the tool becomes callable → assert
B's Cedar gating by the B-user's groups → assert B rejects an ID token and requires an access
token (#327).

Set these environment variables to run it live (the suite still runs `workers=1`, serially):

| Variable | Required | Meaning |
|---|---|---|
| `GATEWAY_B_MCP_URL` | **yes** (the trigger) | Deployment B's `/mcp` gateway endpoint, registered as A's 3LO target. Absent → the spec skips. |
| `GATEWAY_B_OAUTH_DISCOVERY_URL` | yes | B's **Hosted-UI** OIDC discovery URL (must resolve to a `*.amazoncognito.com/oauth2/authorize` endpoint, not `cognito-idp.*` — #328). |
| `GATEWAY_B_OAUTH_CLIENT_ID` | yes | B's Auth-Code+PKCE app-client id used by A's credential provider. |
| `GATEWAY_B_OAUTH_CLIENT_SECRET_ARN` | yes | Secrets Manager ARN **in A** holding `{ "clientSecret": "…" }` for that client. |
| `GATEWAY_B_USERNAME` / `GATEWAY_B_PASSWORD` | yes | A **B-pool** user's Hosted-UI credentials for the consent popup. |
| `GATEWAY_B_EXPECTED_TOOL` | yes | Fully-qualified gateway tool name (`<target>___<tool>`) that becomes callable after consent and that the B-user's groups permit. |
| `GATEWAY_B_ACCESS_TOKEN` | optional | A B-pool **access** token — the #327 sub-step asserts B accepts it. Skipped if unset. |
| `GATEWAY_B_ID_TOKEN` | optional | A B-pool **ID** token — the #327 sub-step asserts B rejects it (403 `insufficient_scope`). Skipped if unset. |

The `GATEWAY_B_ACCESS_TOKEN`/`GATEWAY_B_ID_TOKEN` pair can be minted with a Cognito
`USER_PASSWORD_AUTH` `InitiateAuth` against B's app client (same flow as `web/e2e/auth.setup.ts`).

---

## Troubleshooting

- **`BadRequest` at the consent popup / `authorize` 404** → the discovery URL resolved to the
  control-plane host. Fix per #328; see
  [`docs/mcp-server-integration.md`](mcp-server-integration.md#troubleshooting-gateway-authorize-request-returns-badrequest).
- **403 `insufficient_scope` when calling B** → an ID token reached B instead of an access
  token (#327). Ensure the credential provider / app-client flow yields an access token.
- **Every federated call returns JSON-RPC `-32002` "denied by default"** → the B-pool user
  has no B-side `GroupToolGrant` for that tool. Grant it in B's Permissions tab
  ([`docs/tool-governance.md`](tool-governance.md)).
- **Consent never completes / redirect rejected** → A's provider `oauthCallbackUrl` was not
  added to B's app-client authorized redirect URIs (step 3.1).
- **Elicitation never appears; call just succeeds/fails silently** → the target wasn't
  registered with the OAUTH credential provider. Confirm the row has `oauthProviderArn`
  populated and a `gatewayTargetId` (slice 3).
