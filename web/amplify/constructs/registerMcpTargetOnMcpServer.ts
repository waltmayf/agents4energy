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
      // NodejsFunction excludes @aws-sdk/* from the bundle by default on Node
      // 18+ runtimes, relying on the (older) SDK baked into the Lambda
      // runtime, which throws at runtime on newer client-bedrock-agentcore-control
      // request shapes (confirmed: "Cannot read properties of undefined
      // (reading '0')" inside se_CreateGatewayTargetCommand). Bundle this
      // client explicitly so the handler gets the version pinned in package.json.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // Grant permissions to create, update, and delete gateway targets. Update
    // is needed to attach/detach the OAuth2 credential provider (epic #412
    // slice 3, #415) when an McpServer row's outbound auth config changes
    // after the target already exists. Delete runs on a DynamoDB REMOVE
    // event so a deleted McpServer row doesn't leave its gateway target
    // orphaned forever — that gap let stale e2e-test targets silently eat
    // the whole gateway's 100-target quota until a real deploy's
    // CreateGatewayTarget failed on it (#524).
    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
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
