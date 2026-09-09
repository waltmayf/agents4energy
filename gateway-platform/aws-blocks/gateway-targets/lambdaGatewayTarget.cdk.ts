import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { ToolDefinition } from '@aws-sdk/client-bedrock-agentcore-control';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LambdaGatewayTargetProps {
  /** The AgentCore gateway to register the target on. */
  gatewayIdentifier: string;
  /** ARN of the AgentCore gateway to register the target on — scopes the handler's IAM grant. */
  gatewayArn: string;
  /** Physical name for the gateway target (unique within the gateway). */
  targetName: string;
  /** ARN of the Lambda backing this target's tools. */
  lambdaArn: string;
  /** MCP tool schemas exposed by this target (ToolSchema.InlinePayload). */
  toolDefinitions: ToolDefinition[];
}

/**
 * Registers a Lambda as a Lambda-backed AgentCore Gateway target via a CDK
 * custom resource — CreateGatewayTarget isn't a native CloudFormation
 * resource, so a custom resource is the deploy-time hook. Idempotency
 * (create-if-absent) is handled in the handler by listing existing targets
 * by name before creating.
 *
 * Consolidated from four near-identical copies that used to live in
 * web/amplify/constructs/{s3Tools,graphTraverse,athenaPySpark,cfdTools}
 * GatewayTarget/resource.ts — each differed only in `toolDefinitions` and the
 * target/Lambda identity, so this generic version takes those as props
 * instead (#536). Uses `targetType: 'lambdaFunctionArn'` semantics (a raw
 * Lambda ARN + inline tool schema via the SDK), NOT the declarative
 * `targetType: 'lambda'` CDK path — that path only bundles Python at synth
 * time (spike #533 finding) and would throw for these Node.js Lambdas.
 */
export class LambdaGatewayTarget extends Construct {
  /** The AgentCore gateway target id (custom resource's PhysicalResourceId). */
  public readonly targetId: string;

  constructor(scope: Construct, id: string, props: LambdaGatewayTargetProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'lambdaGatewayTarget.handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      // NodejsFunction excludes @aws-sdk/* from the bundle by default on Node
      // 18+ runtimes, relying on the (older) SDK baked into the Lambda
      // runtime. That version throws on newer client-bedrock-agentcore-control
      // request shapes ("Cannot read properties of undefined (reading '0')"
      // inside se_CreateGatewayTargetCommand) — bundle this client explicitly.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // Create/Update/Delete/GetGatewayTarget support resource-level permissions
    // scoped to the parent gateway's ARN (see aws-cdk-lib's own
    // GatewayBase.grantManage/grantRead). ListGatewayTargets does not support
    // resource-level scoping and must stay on '*'.
    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateGatewayTarget',
        'bedrock-agentcore:UpdateGatewayTarget',
        'bedrock-agentcore:DeleteGatewayTarget',
        'bedrock-agentcore:GetGatewayTarget',
        // Create/Update/DeleteGatewayTarget internally re-synchronize the
        // gateway's target set, so the control plane also authorizes
        // SynchronizeGatewayTargets on the parent gateway — without it,
        // CreateGatewayTarget fails with AccessDenied.
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
        ToolDefinitionsJson: JSON.stringify(props.toolDefinitions),
      },
    });

    this.targetId = resource.ref;
  }
}
