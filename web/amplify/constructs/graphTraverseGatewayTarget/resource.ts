import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface GraphTraverseGatewayTargetProps {
  /** The AgentCore gateway to register the target on. */
  gatewayIdentifier: string;
  /** ARN of the AgentCore gateway to register the target on — scopes the handler's IAM grant. */
  gatewayArn: string;
  /** Physical name for the gateway target (unique within the gateway). */
  targetName: string;
  /** ARN of the graph-traverse Lambda backing the TraverseGraph tool. */
  lambdaArn: string;
}

/**
 * Registers the graph-traverse Lambda as a Lambda-backed AgentCore Gateway
 * target exposing the `TraverseGraph` knowledge-graph traversal tool (issue
 * #291), via a CDK custom resource — same Provider + NodejsFunction pattern as
 * web/amplify/constructs/s3ToolsGatewayTarget. CreateGatewayTarget isn't a
 * native CloudFormation resource, so a custom resource is the deploy-time hook;
 * idempotency (create-if-absent) is handled in handler.ts by listing existing
 * targets by name before creating.
 */
export class GraphTraverseGatewayTarget extends Construct {
  constructor(scope: Construct, id: string, props: GraphTraverseGatewayTargetProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      // NodejsFunction excludes @aws-sdk/* from the bundle by default on Node
      // 18+ runtimes, relying on the (older) SDK baked into the Lambda
      // runtime. That version throws on newer client-bedrock-agentcore-control
      // request shapes (confirmed on the sibling registerMcpTargetOnMcpServer
      // construct: "Cannot read properties of undefined (reading '0')" inside
      // se_CreateGatewayTargetCommand). Bundle this client explicitly so the
      // handler gets the version pinned in package.json.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // Create/Update/Delete/GetGatewayTarget support resource-level permissions
    // scoped to the parent gateway's ARN; ListGatewayTargets does not and must
    // stay on '*' — see the S3ToolsGatewayTarget construct for the rationale
    // (matches aws-cdk-lib's GatewayBase.grantManage/grantRead split).
    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
        'bedrock-agentcore:GetGatewayTarget',
        'bedrock-agentcore:SynchronizeGatewayTargets',
      ],
      resources: [props.gatewayArn],
    }));
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock-agentcore:ListGatewayTargets'],
      resources: ['*'],
    }));

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        GatewayIdentifier: props.gatewayIdentifier,
        TargetName: props.targetName,
        LambdaArn: props.lambdaArn,
      },
    });
  }
}
