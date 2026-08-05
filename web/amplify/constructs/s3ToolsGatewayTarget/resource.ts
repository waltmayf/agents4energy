import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface S3ToolsGatewayTargetProps {
  /** The AgentCore gateway to register the target on. */
  gatewayIdentifier: string;
  /** Physical name for the gateway target (unique within the gateway). */
  targetName: string;
  /** ARN of the s3-tools Lambda backing the ApplyDiff/ListFiles/ReadFile/DeleteFile tools. */
  lambdaArn: string;
}

/**
 * Registers the s3-tools Lambda as a Lambda-backed AgentCore Gateway target
 * exposing the ApplyDiff/ListFiles/ReadFile/DeleteFile filesystem tools
 * (issue #240), via a CDK custom resource — same Provider + NodejsFunction
 * pattern as web/amplify/constructs/e2eTestUser. CreateGatewayTarget isn't a
 * native CloudFormation resource, so a custom resource is the deploy-time
 * hook; idempotency (create-if-absent) is handled in handler.ts by listing
 * existing targets by name before creating.
 */
export class S3ToolsGatewayTarget extends Construct {
  constructor(scope: Construct, id: string, props: S3ToolsGatewayTargetProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
    });

    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
        'bedrock-agentcore:ListGatewayTargets',
        'bedrock-agentcore:GetGatewayTarget',
      ],
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
