import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AthenaPySparkGatewayTargetProps {
  /** The AgentCore gateway to register the target on. */
  gatewayIdentifier: string;
  /** ARN of the AgentCore gateway to register the target on — scopes the handler's IAM grant. */
  gatewayArn: string;
  /** Physical name for the gateway target (unique within the gateway). */
  targetName: string;
  /** ARN of the athena-pyspark Lambda backing the SubmitPySpark/GetPySparkStatus/GetPySparkResults tools. */
  lambdaArn: string;
}

/**
 * Registers the athena-pyspark Lambda as a Lambda-backed AgentCore Gateway
 * target exposing the SubmitPySpark/GetPySparkStatus/GetPySparkResults trio
 * (issue #501), via a CDK custom resource — copy of
 * web/amplify/constructs/graphTraverseGatewayTarget with only
 * toolDefinitions() and the class name changed. CreateGatewayTarget isn't a
 * native CloudFormation resource, so a custom resource is the deploy-time
 * hook; idempotency (create-if-absent) is handled in handler.ts by listing
 * existing targets by name before creating.
 */
export class AthenaPySparkGatewayTarget extends Construct {
  /** The AgentCore gateway target id (custom resource's PhysicalResourceId) — feed into AthenaPySparkMcpServerSeed. */
  public readonly targetId: string;

  constructor(scope: Construct, id: string, props: AthenaPySparkGatewayTargetProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      // See GraphTraverseGatewayTarget for why this client is bundled explicitly
      // rather than relying on the (older) SDK baked into the Lambda runtime.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // Create/Update/Delete/GetGatewayTarget support resource-level permissions
    // scoped to the parent gateway's ARN; ListGatewayTargets does not and must
    // stay on '*' — see the S3ToolsGatewayTarget construct for the rationale.
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

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        GatewayIdentifier: props.gatewayIdentifier,
        TargetName: props.targetName,
        LambdaArn: props.lambdaArn,
      },
    });

    this.targetId = resource.ref;
  }
}
