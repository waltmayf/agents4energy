import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  UpdateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListGatewayTargetsCommand,
  SchemaType,
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
}

const PATH_PROPERTY = {
  type: SchemaType.STRING,
  description:
    'Filesystem path, resolved under the shared "files/" root. Absolute (leading "/") and relative paths both resolve from that same root, e.g. "/docs/production/gas_lift.md" or "reports/q3.md".',
};

const toolDefinitions = (): ToolDefinition[] => [
  {
    name: 'ApplyDiff',
    description:
      'Create or modify a file using one or more SEARCH/REPLACE blocks (Aider/Roo-Code apply_diff style). '
      + 'An empty SEARCH block against a non-existent path creates the file with the REPLACE body as its full content.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        path: PATH_PROPERTY,
        diff: {
          type: SchemaType.STRING,
          description:
            'One or more SEARCH/REPLACE blocks: "<<<<<<< SEARCH" then the exact existing content, then "=======", '
            + 'then the replacement content, then ">>>>>>> REPLACE". An optional ":start_line:<N>" hint line may '
            + 'follow the SEARCH marker.',
        },
      },
      required: ['path', 'diff'],
    },
  },
  {
    name: 'ListFiles',
    description: 'List files and sub-"directories" under a path (defaults to the filesystem root).',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        path: { ...PATH_PROPERTY, description: `${PATH_PROPERTY.description} Omit to list the filesystem root.` },
        recursive: {
          type: SchemaType.BOOLEAN,
          description: 'List all nested files recursively instead of only the immediate contents. Defaults to false.',
        },
      },
    },
  },
  {
    name: 'ReadFile',
    description: 'Read a file\'s contents as text.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: { path: PATH_PROPERTY },
      required: ['path'],
    },
  },
  {
    name: 'DeleteFile',
    description: 'Delete a file.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: { path: PATH_PROPERTY },
      required: ['path'],
    },
  },
];

function buildTargetConfiguration(lambdaArn: string): TargetConfiguration {
  return {
    mcp: {
      lambda: {
        lambdaArn,
        toolSchema: { inlinePayload: toolDefinitions() },
      },
    },
  };
}

// CreateGatewayTarget requires credentialProviderConfigurations to be set
// explicitly (it does NOT default) — without it the call fails with the
// ValidationException "Credential provider configurations is not defined".
// A Lambda target is invoked with the gateway's own execution role, so use
// GATEWAY_IAM_ROLE (paired with the identity-based lambda:InvokeFunction grant
// on that role in backend.ts). This is the auto-config the @aws/agentcore-cdk
// Gateway component applies for inline Lambda targets; out-of-band targets
// must supply it themselves.
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
    const targetConfiguration = buildTargetConfiguration(props.LambdaArn);

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
