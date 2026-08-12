import { DynamoDBStreamHandler } from 'aws-lambda';
import { AttributeValue, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { BedrockAgentCoreControlClient, CreateGatewayTargetCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GATEWAY_ID = process.env.GATEWAY_ID!;

const controlClient = new BedrockAgentCoreControlClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

// Helper to generate safe gateway target name (same logic as register-mcp-target handler).
function safeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'mcp-target';
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;
    const item = unmarshall(newImage as unknown as Record<string, AttributeValue>);
    const { id, name, url, description, gatewayTargetId } = item as any;

    // Self-heal a poisoned `name` (#387). `name` is `a.string().required()`,
    // but Amplify's generated `UpdateMcpServerInput` makes every field
    // nullable regardless of the model's `.required()` (partial-update
    // semantics), and the default DynamoDB resolver REMOVEs any attribute an
    // update explicitly sets to null — so an `updateMcpServer` mutation with
    // `name: null` silently drops the attribute with no validation error.
    // That poisons every `listMcpServers` query for everyone via AppSync's
    // non-null propagation (the generated connection type is
    // `items: [McpServer!]!`). Only MODIFY can produce this — createMcpServer
    // requires `name` at the GraphQL layer — so restore it from OldImage.
    if (!name && record.eventName === 'MODIFY') {
      const oldImage = record.dynamodb?.OldImage;
      const oldName = oldImage
        ? (unmarshall(oldImage as unknown as Record<string, AttributeValue>) as any).name
        : undefined;
      if (oldName) {
        await ddb.send(
          new UpdateItemCommand({
            TableName: process.env.MCP_SERVER_TABLE_NAME!,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #n = :n',
            ExpressionAttributeNames: { '#n': 'name' },
            ExpressionAttributeValues: { ':n': { S: oldName } },
          }),
        );
        console.warn(`[register-mcp-target-stream] Restored null name on McpServer ${id} to "${oldName}" (#387).`);
      } else {
        console.warn(`[register-mcp-target-stream] McpServer ${id} has a null name with no prior value to restore.`);
      }
      continue; // our own UpdateItem re-triggers this handler; skip registration this pass
    }

    if (gatewayTargetId) continue; // already registered
    // Register gateway target
    const result = await controlClient.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: GATEWAY_ID,
        name: safeName(name),
        description: description ?? `MCP server: ${name}`,
        targetConfiguration: {
          mcp: { mcpServer: { endpoint: url } },
        },
      }),
    );
    const targetId = result.targetId;
    if (!targetId) continue;
    // Update DynamoDB item with the targetId
    await ddb.send(
      new UpdateItemCommand({
        TableName: process.env.MCP_SERVER_TABLE_NAME!,
        Key: { id: { S: id } },
        UpdateExpression: 'SET gatewayTargetId = :gt',
        ExpressionAttributeValues: { ':gt': { S: targetId } },
      }),
    );
  }
};
