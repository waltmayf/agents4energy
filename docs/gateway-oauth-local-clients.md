# Gateway OAuth Clients (Runtime-Configurable Trust)

Tracks who the AgentCore gateway's `CUSTOM_JWT` authorizer trusts as a caller, and which redirect URIs the primary Cognito app client will complete a hosted-UI OAuth flow against. This is the mechanism epic #412 ("federate a second deployment at runtime") builds on.

---

## The two IaC-owned lists, and why out-of-band edits used to be drift

Two pieces of caller trust are declared in `web/amplify/backend.ts`:

1. **The gateway's `allowedClients`** — the list of Cognito app client IDs the `CUSTOM_JWT` authorizer accepts a bearer token from. Set on gateway *creation* in the `agentCoreGatewaysWithUniqueNames` block, and separately reconciled onto an *already-existing* gateway by `ReconcileGatewayAuthorizer` (`web/amplify/constructs/reconcileGatewayAuthorizer/`) — see #328/#128 for why an existing gateway needs its own reconcile path (CloudFormation only reads a gateway's authorizer config on `CREATE`).
2. **The primary app client's `callbackUrLs`** — the redirect URIs Cognito's hosted UI will send an authorization code to, set directly on the `CfnUserPoolClient` escape hatch.

Before #418, both lists were assembled purely from CDK/synth-time constants (the browser app client + the `service-webhook` machine-identity client, plus one fixed local MCP OAuth callback). Anyone who ran `update-gateway` or `update-user-pool-client` out-of-band to trust a second deployment's client — the only way to federate before this issue — was making a change **the next `pnpm deploy` would silently clobber**: `ReconcileGatewayAuthorizer` runs on every deploy (issue #328) and always recomputes the full desired list from those same synth-time constants, overwriting anything added by hand.

## The fix: `TrustedOAuthClient` as the runtime source of truth

`TrustedOAuthClient` (`web/amplify/data/schemas/federation.schema.ts`) is a flat, admin-editable DynamoDB-backed table:

| Field | Meaning |
|---|---|
| `clientId` | A Cognito app client ID to add to the gateway's `allowedClients` |
| `callbackUrl` | An OAuth redirect URI to add to the primary app client's `callbackUrLs` (optional — only needed if the trusted caller completes a hosted-UI authorization-code flow against this pool) |
| `description` | Free-text note (e.g. which deployment/caller this row is for) |
| `enabled` | Defaults to `true`. Set `false` to revoke trust without losing the row's metadata — a disabled row is excluded from both derived sets |

Authorization: only the `admin` Cognito group can create/update/delete; any authenticated user can read.

At reconcile time (see below), the handler scans this table and **unions** the enabled rows' `clientId`s and `callbackUrl`s with the IaC-known base sets (primary client + `service-webhook` client; the fixed local MCP OAuth callback) — full recompute each time, not merge-with-whatever-is-currently-live, so **disabling or deleting a row also retracts its trust**, not just additions.

## Reconcile: on deploy AND on data change

`ReconcileGatewayAuthorizer`'s Lambda (`web/amplify/constructs/reconcileGatewayAuthorizer/{resource,handler,reconcile}.ts`) now has two triggers sharing the same handler and the same `reconcile()` core logic:

1. **Deploy-time `CustomResource`** (unchanged mechanism from #328): a `Nonce` property that changes every synth forces CloudFormation to re-invoke the handler on every deploy.
2. **DynamoDB Stream on `TrustedOAuthClient`** (new, #418): any `INSERT`/`MODIFY`/`REMOVE` on the table invokes the same Lambda within seconds. The stream record's contents are never read — arrival is only a "something changed" signal, and the handler always re-scans the whole table — so a batch edit, a retried/duplicate event, or a missed record can never leave the gateway/app-client out of sync with the table's current state.

Both triggers call the same two idempotent sub-reconciles:

- **Gateway authorizer**: `GetGateway` → compare `discoveryUrl`/`allowedClients` against the desired union → `UpdateGateway` only if different. `UpdateGateway` is a full-replacement PUT, so the handler echoes back `name`/`roleArn`/`description`/`protocolType`/`protocolConfiguration` from the `GetGateway` response, changing only the authorizer block.
- **App-client callback URLs**: `DescribeUserPoolClient` → compare `CallbackURLs` against the desired union → `UpdateUserPoolClient` only if different. Like `UpdateGateway`, `UpdateUserPoolClient` resets any omitted field to its documented default rather than leaving it unchanged, so the handler echoes back every other field from the `Describe` response and overrides only `CallbackURLs`.

A steady-state deploy or a no-op stream event (e.g. a `MODIFY` that didn't touch `clientId`/`callbackUrl`/`enabled`) therefore makes **zero** control-plane calls.

## Cross-stack wiring

`ReconcileGatewayAuthorizer` lives in its own `backend.createStack('reconcile-gateway-authorizer')`, as a raw `NodejsFunction` (not an Amplify `defineFunction`) — same reasoning as `SyncCedarPolicies`/`S3ToolsGatewayTarget`: the handler references the data stack's `TrustedOAuthClient` table via env (table name), IAM (`dynamodb:Scan` on the table ARN, plus the `DynamoEventSource`'s stream-read grant), so a `defineFunction` (which lives in Amplify's shared function stack, already depended on by the data stack) would close a `data → function → data` cycle. This sink stack depends on the data stack (table) and the auth/agent stacks (pool/client/gateway) and is depended on by neither — no cycle. Verified by `pnpm test:synth` (issue #152's synth gate).

## Federating a second deployment

To trust deployment B's app client from deployment A's gateway, without redeploying A:

1. Sign in to deployment A as an `admin` user.
2. Create a `TrustedOAuthClient` row with `clientId` set to deployment B's Cognito app client ID (and `callbackUrl` if B needs a hosted-UI redirect back to it).
3. Within seconds, deployment A's gateway authorizer accepts B's tokens, and (if a `callbackUrl` was set) A's hosted UI will redirect there after login — no `pnpm deploy` required.
4. To revoke, set `enabled: false` (or delete the row) — the next reconcile drops both the `clientId` and `callbackUrl` from the live gateway/app-client.

This is independent of, and a prerequisite for, the outbound "gateway calls another gateway" 3LO flow (#412 slice 8) being runtime-configurable — that slice still needs to be implemented separately.
