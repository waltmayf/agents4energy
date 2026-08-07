import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RegisterMcpTargetOnMcpServerProps {
  /** The gateway identifier to register targets against */
  gatewayId: string;
  /** The MCP Server DynamoDB table */
  mcpServerTable: ITable;
}

/**
 * Stream-triggered Lambda that registers newly created or updated MCP server rows
 * as AgentCore gateway targets, persisting the resulting gatewayTargetId back to the
 * DynamoDB record.
 */
export class RegisterMcpTargetOnMcpServer extends Construct {
  constructor(scope: Construct, id: string, props: RegisterMcpTargetOnMcpServerProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, '../functions/register-mcp-target-stream/handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: {
        GATEWAY_ID: props.gatewayId,
        MCP_SERVER_TABLE_NAME: props.mcpServerTable.tableName,
      },
    });

    // Grant permissions to create gateway targets.
    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:SynchronizeGatewayTargets',
      ],
      resources: ['*'],
    }));

    // Permissions to read and update the MCP Server table.
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [props.mcpServerTable.tableArn],
    }));

    // Stream source – trigger on INSERT or MODIFY.
    fn.addEventSource(new DynamoEventSource(props.mcpServerTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 1,
      retryAttempts: 3,
    }));
  }
}
