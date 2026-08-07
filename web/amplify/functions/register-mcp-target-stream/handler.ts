import { DynamoDBStreamHandler } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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
    const item = unmarshall(newImage);
    const { id, name, url, description, gatewayTargetId } = item as any;
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
