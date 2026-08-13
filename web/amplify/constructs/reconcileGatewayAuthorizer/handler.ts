import type { CdkCustomResourceEvent, CdkCustomResourceResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { reconcile, type ReconcileInput } from './reconcile';

/**
 * Reconcile an EXISTING AgentCore gateway's CUSTOM_JWT authorizer and the
 * primary app client's callbackUrLs to this stack's live pool/client PLUS
 * whatever extra TrustedOAuthClient rows exist (#412 slice 6), on:
 *
 *  - every deploy: this function is the Provider's onEventHandler behind a
 *    CustomResource whose Nonce property changes every synth, so
 *    CloudFormation always re-invokes it (issue #328's original fix).
 *  - every TrustedOAuthClient change: this SAME function is also wired as a
 *    DynamoDB Stream consumer on that table (see resource.ts), so adding,
 *    editing, or disabling a row takes effect within seconds — not only at
 *    the next `pnpm deploy`.
 *
 * Reconcile inputs are all deploy-time constants, so they travel via
 * environment variables (stable across both trigger types) rather than the
 * CustomResource's ResourceProperties — those carry only the Nonce.
 */
function readInputFromEnv(): ReconcileInput {
  return {
    gatewayIdentifier: process.env.GATEWAY_IDENTIFIER!,
    discoveryUrl: process.env.DISCOVERY_URL!,
    baseAllowedClients: JSON.parse(process.env.BASE_ALLOWED_CLIENTS!),
    trustedOAuthClientTableName: process.env.TRUSTED_OAUTH_CLIENT_TABLE_NAME!,
    userPoolId: process.env.USER_POOL_ID!,
    primaryClientId: process.env.PRIMARY_CLIENT_ID!,
    baseCallbackUrls: JSON.parse(process.env.BASE_CALLBACK_URLS!),
  };
}

function isCustomResourceEvent(
  event: CdkCustomResourceEvent | DynamoDBStreamEvent,
): event is CdkCustomResourceEvent {
  return 'RequestType' in event;
}

export const handler = async (
  event: CdkCustomResourceEvent | DynamoDBStreamEvent,
): Promise<CdkCustomResourceResponse | void> => {
  if (isCustomResourceEvent(event)) {
    if (event.RequestType === 'Delete') {
      // Reconciliation owns no resource of its own — the gateway and app
      // client outlive this custom resource. Nothing to tear down.
      return { PhysicalResourceId: event.PhysicalResourceId };
    }

    const input = readInputFromEnv();
    await reconcile(input);
    return { PhysicalResourceId: `reconcile-authorizer-${input.gatewayIdentifier}` };
  }

  // DynamoDB Stream event from TrustedOAuthClient — a "something changed"
  // signal only; reconcile() always does a full rescan (see its doc comment).
  await reconcile(readInputFromEnv());
};
