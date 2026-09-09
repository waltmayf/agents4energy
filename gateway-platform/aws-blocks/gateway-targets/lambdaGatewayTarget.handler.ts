import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  UpdateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListGatewayTargetsCommand,
  CredentialProviderType,
  type ToolDefinition,
  type TargetConfiguration,
  type CredentialProviderConfiguration,
} from '@aws-sdk/client-bedrock-agentcore-control';

const client = new BedrockAgentCoreControlClient({});

interface ResourceProperties {
  GatewayIdentifier: string;
  TargetName: string;
  LambdaArn: string;
  // JSON-encoded ToolDefinition[] — custom resource properties are plain
  // strings/JSON, so the per-tool schema (varies per target) is passed in
  // rather than hardcoded, unlike the single-target constructs this was
  // consolidated from (see #536).
  ToolDefinitionsJson: string;
}

function buildTargetConfiguration(lambdaArn: string, toolDefinitions: ToolDefinition[]): TargetConfiguration {
  return {
    mcp: {
      lambda: {
        lambdaArn,
        toolSchema: { inlinePayload: toolDefinitions },
      },
    },
  };
}

// CreateGatewayTarget requires credentialProviderConfigurations to be set
// explicitly (it does NOT default) — without it the call fails with the
// ValidationException "Credential provider configurations is not defined".
// A Lambda target is invoked with the gateway's own execution role, so use
// GATEWAY_IAM_ROLE (paired with the identity-based lambda:InvokeFunction grant
// on that role in agentcore-gateway.cdk.ts).
const credentialProviderConfigurations: CredentialProviderConfiguration[] = [
  { credentialProviderType: CredentialProviderType.GATEWAY_IAM_ROLE },
];

async function findExistingTargetId(gatewayIdentifier: string, targetName: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier, nextToken }));
    const match = (res.items ?? []).find((t) => t.name === targetName);
    if (match?.targetId) return match.targetId;
    nextToken = res.nextToken;
  } while (nextToken);
  return undefined;
}

export const handler = async (
  event: CdkCustomResourceEvent,
): Promise<CdkCustomResourceResponse> => {
  const props = event.ResourceProperties as unknown as ResourceProperties;

  if (event.RequestType === 'Create' || event.RequestType === 'Update') {
    const toolDefinitions: ToolDefinition[] = JSON.parse(props.ToolDefinitionsJson);
    const targetConfiguration = buildTargetConfiguration(props.LambdaArn, toolDefinitions);

    // Create-if-absent: look up by name first so a redeploy (e.g. a synth
    // that recreates this custom resource with a new logical id/physical id)
    // updates the existing target instead of failing on "already exists".
    const existingTargetId = await findExistingTargetId(props.GatewayIdentifier, props.TargetName);

    if (existingTargetId) {
      await client.send(new UpdateGatewayTargetCommand({
        gatewayIdentifier: props.GatewayIdentifier,
        targetId: existingTargetId,
        name: props.TargetName,
        targetConfiguration,
        credentialProviderConfigurations,
      }));
      return { PhysicalResourceId: existingTargetId };
    }

    const created = await client.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: props.GatewayIdentifier,
      name: props.TargetName,
      targetConfiguration,
      credentialProviderConfigurations,
    }));
    if (!created.targetId) throw new Error('CreateGatewayTarget did not return a targetId');
    return { PhysicalResourceId: created.targetId };
  }

  // event.RequestType === 'Delete'
  try {
    await client.send(new DeleteGatewayTargetCommand({
      gatewayIdentifier: props.GatewayIdentifier,
      targetId: event.PhysicalResourceId,
    }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
};
