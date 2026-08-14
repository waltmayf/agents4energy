import { a } from '@aws-amplify/backend';

/**
 * Federation Schema (#412 slice 6/8)
 *
 * TrustedOAuthClient — admin-managed, runtime source of truth for extending
 * cross-deployment gateway trust without a redeploy. Today the gateway's
 * CUSTOM_JWT `allowedClients` and the primary app client's `callbackUrLs` are
 * IaC-owned (see backend.ts + ReconcileGatewayAuthorizer) — any out-of-band
 * `update-gateway`/`update-user-pool-client` addition is drift the next
 * deploy clobbers. Rows here are unioned with the IaC-known primary (+
 * service-webhook) client at reconcile time, and ReconcileGatewayAuthorizer
 * reconciles both on every deploy AND on every change to this table (via a
 * DynamoDB Stream), so adding/removing a row takes effect within seconds.
 */
export const federationSchema = a.schema({

  TrustedOAuthClient: a.model({
    // Cognito app client ID (from this deployment or another) to add to the
    // gateway's CUSTOM_JWT allowedClients.
    clientId: a.string().required(),
    // Optional OAuth redirect URI to add to the primary app client's
    // callbackUrLs — needed when the federated caller completes a hosted-UI
    // authorization-code flow against this pool.
    callbackUrl: a.string(),
    description: a.string(),
    // Reconcile drops disabled rows from both allowedClients and
    // callbackUrLs without deleting the row — lets an admin temporarily
    // revoke trust without losing the client's metadata.
    enabled: a.boolean().required().default(true),
  }).authorization((allow) => [
    allow.group('admin').to(['read', 'create', 'update', 'delete']),
    allow.authenticated().to(['read']),
  ]),
});
