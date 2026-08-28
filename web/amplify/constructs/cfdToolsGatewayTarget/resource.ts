import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CfdToolsGatewayTargetProps {
  /** The AgentCore gateway to register the target on. */
  gatewayIdentifier: string;
  /** ARN of the AgentCore gateway to register the target on — scopes the handler's IAM grant. */
  gatewayArn: string;
  /** Physical name for the gateway target (unique within the gateway). */
  targetName: string;
  /** ARN of the cfd-tools Lambda backing the SubmitCfdSimulation/GetCfdJobStatus/GetCfdResults tools. */
  lambdaArn: string;
}

/**
 * Registers the cfd-tools Lambda as a Lambda-backed AgentCore Gateway target
 * exposing the SubmitCfdSimulation/GetCfdJobStatus/GetCfdResults tools (issue
 * #504, epic #498 slice 6) — same Provider + NodejsFunction custom-resource
 * pattern as web/amplify/constructs/s3ToolsGatewayTarget (see that resource's
 * doc for why this needs a custom resource: CreateGatewayTarget isn't a
 * native CloudFormation resource).
 */
export class CfdToolsGatewayTarget extends Construct {
  /** The AgentCore gateway target id (custom resource's PhysicalResourceId) — feed into CfdToolsMcpServerSeed. */
  public readonly targetId: string;

  constructor(scope: Construct, id: string, props: CfdToolsGatewayTargetProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      // See S3ToolsGatewayTarget's identical comment: NodejsFunction excludes
      // @aws-sdk/* from the bundle by default, relying on the (older) SDK
      // baked into the Lambda runtime, which throws on newer
      // client-bedrock-agentcore-control request shapes.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

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
