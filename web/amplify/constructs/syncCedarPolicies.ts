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

export interface SyncCedarPoliciesProps {
  /** Id of the DefaultCedar policy engine (#271) generated policies are pushed to. */
  policyEngineId: string;
  /** ARN of the DefaultCedar policy engine — scopes the handler's CreatePolicy/UpdatePolicy/etc. grant. */
  policyEngineArn: string;
  /** Gateway id the engine is attached to — used by the handler to resolve gateway-target names. */
  gatewayId: string;
  /** ARN of the gateway the engine is attached to — Cedar policies must pin `resource` to this exact gateway (see cedar-policy-generation.ts). */
  gatewayArn: string;
  /** GroupToolGrant table — the source of truth for grants, and the DynamoDB Stream trigger. */
  groupToolGrantTable: ITable;
  /** McpServer table — read to map mcpServerId → gatewayTargetId when generating Cedar actions. */
  mcpServerTable: ITable;
}

/**
 * Stream-triggered Lambda that regenerates the DefaultCedar policy set from
 * GroupToolGrant rows on every grant change (#272). See
 * web/amplify/functions/sync-cedar-policies/handler.ts for the reconcile logic.
 *
 * Built as a raw NodejsFunction (not an Amplify `defineFunction`) so it can be
 * placed in its OWN CDK stack rather than Amplify's shared **function** stack.
 * The handler references data-stack tables three ways — env (tableName), IAM
 * (dynamodb:Scan on tableArn), and a DynamoEventSource on the GroupToolGrant
 * stream. A `defineFunction` lives in the function stack, which the **data**
 * stack already depends on (its custom-query resolvers point at function-stack
 * Lambdas), so any function→data edge closes a `data → function → data` cycle
 * CloudFormation rejects at synth (the #152 CDK-synth gate catches it). This
 * sink stack instead depends on both the data stack (tables) and the agent
 * stack (policy engine ARN) and is depended on by neither — no cycle. Same
 * reasoning as S3ToolsGatewayTarget / AgentWebhookStack.
 */
export class SyncCedarPolicies extends Construct {
  constructor(scope: Construct, id: string, props: SyncCedarPoliciesProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, '../functions/sync-cedar-policies/handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: {
        POLICY_ENGINE_ID: props.policyEngineId,
        GATEWAY_ID: props.gatewayId,
        GATEWAY_ARN: props.gatewayArn,
        GROUP_TOOL_GRANT_TABLE_NAME: props.groupToolGrantTable.tableName,
        MCP_SERVER_TABLE_NAME: props.mcpServerTable.tableName,
      },
      // NodejsFunction excludes @aws-sdk/* from the bundle by default on Node
      // 18+ runtimes, relying on the SDK version baked into the Lambda
      // runtime — which predates the Cedar Policy APIs (ListPolicies,
      // CreatePolicy, etc; confirmed by "ListPoliciesCommand is not a
      // constructor" at runtime). Bundle this client explicitly so the
      // handler gets the version pinned in package.json.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:ListPolicies',
        'bedrock-agentcore:GetPolicy',
        'bedrock-agentcore:CreatePolicy',
        'bedrock-agentcore:UpdatePolicy',
        'bedrock-agentcore:DeletePolicy',
      ],
      resources: [props.policyEngineArn, `${props.policyEngineArn}/*`],
    }));
    // Create/Update/DeletePolicy on a policy whose statement's `resource`
    // clause pins a concrete gateway (required once the action is
    // target-scoped — see cedar-policy-generation.ts) additionally requires
    // this action scoped to that gateway, confirmed live: "not authorized to
    // perform: bedrock-agentcore:ManageResourceScopedPolicy on resource:
    // <gatewayArn>" without it.
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock-agentcore:ManageResourceScopedPolicy'],
      resources: [props.gatewayArn],
    }));
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock-agentcore:GetGatewayTarget'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:Scan'],
      resources: [props.groupToolGrantTable.tableArn, props.mcpServerTable.tableArn],
    }));

    // The stream event is only a "something changed" signal — the handler
    // re-reads and fully reconciles every grant, so batchSize:1 (react to each
    // change promptly) with a few retries is the right trade-off for an
    // infrequent, admin-only write path.
    fn.addEventSource(new DynamoEventSource(props.groupToolGrantTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 1,
      retryAttempts: 3,
    }));
  }
}
