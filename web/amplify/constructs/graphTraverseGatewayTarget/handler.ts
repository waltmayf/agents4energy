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

// Keep in sync with the graph-traverse handler's TraverseEvent + the
// MAX_DEPTH/DEFAULT_* clamps in web/lib/graph-traverse-bfs.ts.
const toolDefinitions = (): ToolDefinition[] => [
  {
    name: 'TraverseGraph',
    description:
      'Traverse the knowledge graph outward from a root node, returning every node and edge within '
      + 'a bounded number of hops plus the frontier boundary node ids (for re-rooting a deeper query). '
      + 'Use it to explore how an entity (well, field, document, dataset, …) connects to its neighbours. '
      + 'The result is { nodes, edges, frontier, truncated }; `truncated` is true when a node\'s fan-out '
      + 'exceeded perLevelLimit and edges were dropped.',
    inputSchema: {
      type: SchemaType.OBJECT,
      properties: {
        rootId: {
          type: SchemaType.STRING,
          description: 'Id of the node to start traversing from (required).',
        },
        depth: {
          type: SchemaType.INTEGER,
          description: 'How many hops to expand. Defaults to 3, clamped to a maximum of 5.',
        },
        direction: {
          type: SchemaType.STRING,
          description:
            'Which edges to follow: "out" (fromId → toId, default), "in" (reverse), or "both". '
            + 'One of "out" | "in" | "both".',
        },
        edgeTypes: {
          type: SchemaType.ARRAY,
          description:
            'Optional edge-type allowlist (e.g. ["belongs_to","derived_from"]). Omit to follow all edge types.',
          items: { type: SchemaType.STRING },
        },
        perLevelLimit: {
          type: SchemaType.INTEGER,
          description:
            'Max edges to expand per node per direction (default 50). Caps fan-out at dense hub nodes; '
            + 'when exceeded the result\'s `truncated` flag is set.',
        },
      },
      required: ['rootId'],
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

// A Lambda target is invoked with the gateway's own execution role, so use
// GATEWAY_IAM_ROLE (paired with the identity-based lambda:InvokeFunction grant
// on that role in backend.ts). CreateGatewayTarget requires
// credentialProviderConfigurations explicitly — see the S3ToolsGatewayTarget
// handler for the full rationale.
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

    // Create-if-absent: look up by name first so a redeploy that recreates this
    // custom resource updates the existing target instead of failing on
    // "already exists".
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
