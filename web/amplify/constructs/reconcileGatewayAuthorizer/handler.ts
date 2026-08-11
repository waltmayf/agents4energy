import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import {
  BedrockAgentCoreControlClient,
  GetGatewayCommand,
  UpdateGatewayCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const client = new BedrockAgentCoreControlClient({});

interface ResourceProperties {
  /** Physical gateway id to reconcile (e.g. default-default-gateway-xxxx). */
  GatewayIdentifier: string;
  /** OIDC discovery URL of THIS stack's live Cognito user pool. */
  DiscoveryUrl: string;
  /** App client ids the gateway should trust (this stack's user-pool client). */
  AllowedClients: string[];
  /** Changing nonce so the custom resource re-runs on every deploy. */
  Nonce?: string;
}

/**
 * Reconcile an EXISTING AgentCore gateway's CUSTOM_JWT authorizer to the
 * current stack's Cognito user pool + app client (issue #328).
 *
 * CloudFormation reads a gateway's discoveryUrl/allowedClients only on CREATE;
 * the backend.ts override (which re-derives them from the live pool) therefore
 * never lands on an already-existing gateway. On the long-lived main deploy
 * that left the gateway frozen on a since-deleted pool, so its advertised
 * authorization server 404'd and MCP OAuth broke (#328/#128). This handler
 * closes that gap by calling UpdateGateway out-of-band every deploy.
 *
 * UpdateGateway is a full-replacement PUT: name/roleArn/protocolType/
 * protocolConfiguration must be supplied or they reset. We GetGateway first and
 * echo the existing values back, overriding only the authorizer. If the
 * authorizer already matches (the steady state), we skip the write so a normal
 * redeploy is a no-op on the control plane.
 */
async function reconcile(props: ResourceProperties): Promise<string> {
  const { GatewayIdentifier: gatewayIdentifier, DiscoveryUrl, AllowedClients } = props;

  const current = await client.send(new GetGatewayCommand({ gatewayIdentifier }));

  const existing = current.authorizerConfiguration?.customJWTAuthorizer;
  const clientsMatch =
    !!existing &&
    existing.discoveryUrl === DiscoveryUrl &&
    JSON.stringify([...(existing.allowedClients ?? [])].sort()) ===
      JSON.stringify([...AllowedClients].sort());

  if (current.authorizerType === 'CUSTOM_JWT' && clientsMatch) {
    // Already reconciled — nothing to do. Keeps steady-state deploys a no-op.
    return gatewayIdentifier;
  }

  if (!current.name || !current.roleArn) {
    throw new Error(
      `GetGateway for ${gatewayIdentifier} returned no name/roleArn; cannot safely UpdateGateway`,
    );
  }

  await client.send(
    new UpdateGatewayCommand({
      gatewayIdentifier,
      // Preserve immutable/echo-required fields from the live gateway.
      name: current.name,
      roleArn: current.roleArn,
      description: current.description,
      protocolType: current.protocolType,
      protocolConfiguration: current.protocolConfiguration,
      // The one thing we're actually changing: point the JWT authorizer at the
      // current stack's live pool + client. Note SDK casing is customJWTAuthorizer
      // (capital JWT), unlike the @aws/agentcore-cdk customJwtAuthorizer.
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: DiscoveryUrl,
          allowedClients: AllowedClients,
        },
      },
    }),
  );

  return gatewayIdentifier;
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  if (event.RequestType === 'Delete') {
    // Reconciliation owns no resource of its own — the gateway outlives this
    // custom resource. Nothing to tear down.
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const physicalId = await reconcile(props);
  return { PhysicalResourceId: `reconcile-authorizer-${physicalId}` };
};
