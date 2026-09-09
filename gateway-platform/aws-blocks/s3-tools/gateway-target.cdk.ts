/**
 * Registers the s3-tools Lambda (ApplyDiff/ListFiles/ReadFile/DeleteFile/
 * UploadFile filesystem tools, issue #240) as a gateway target — moved here
 * from web/amplify/constructs/s3ToolsGatewayTarget by #548, the first of
 * four Lambda-target migrations split from #536 (part of the standalone
 * gateway-platform epic, #532).
 *
 * The Lambda itself stays in Amplify (web/amplify/functions/s3-tools) — it
 * needs Amplify's `agentWorkspace` S3 bucket grants, which only exist in
 * that app. Only the *gateway target registration* moves here, using the
 * `GatewayTarget.forLambda` L2 (`targetType` LAMBDA, backed by a raw
 * `lambdaFunctionArn` + inline tool schema — NOT the declarative
 * `@aws/agentcore-cdk` `targetType: 'lambda'` path, which spike #533 found
 * only bundles Python and throws on Node.js/TypeScript handlers).
 *
 * Cross-app wiring (same contract as #535's gateway-coordinates SSM, just in
 * the opposite direction): Amplify publishes the s3-tools Lambda's ARN to
 * `/agentcore/<amplifyStackName>/s3_tools_lambda_arn` on every deploy (see
 * web/amplify/backend.ts's s3-tools section). This app reads it back via a
 * plain AWS SDK call at synth time (module load, before app.synth()),
 * wrapped in try/catch and defaulting to '' on ANY failure — missing
 * parameter, no credentials, wrong region, anything — exactly like
 * backend.ts's own `readGatewayPlatformSsmParam`. Amplify and gateway-platform
 * must each deploy standalone regardless of the other's state, in any order:
 * when the ARN is unavailable, this target is skipped entirely rather than
 * failing the whole gateway-platform deploy.
 *
 * Unlike GATEWAY_PLATFORM_STACK_NAME's hardcoded production default (stable,
 * because gateway-platform's stack name is derived from a checked-in
 * `stackId` in .blocks/config.json), there is no equivalent stable default
 * here: Amplify deploys one `ampx sandbox` stack per branch with a
 * randomly-suffixed name, not a single fixed "prod" stack. So
 * AMPLIFY_AGENT_STACK_NAME must be passed explicitly (env var or CDK
 * context) for this target to be created; with it unset, this quietly no-ops
 * (matching the "gateway absent" gate pattern in web/amplify/backend.ts).
 */
import * as cdk from 'aws-cdk-lib';
import { GatewayTarget, ToolSchema, type IGateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Construct } from 'constructs';
import { S3_TOOL_DEFINITIONS } from './tool-schema';

async function readAmplifyS3ToolsLambdaArn(): Promise<string> {
  const amplifyStackName = process.env.AMPLIFY_AGENT_STACK_NAME;
  if (!amplifyStackName) return '';
  try {
    const ssm = new SSMClient({});
    const result = await ssm.send(
      new GetParameterCommand({ Name: `/agentcore/${amplifyStackName}/s3_tools_lambda_arn` }),
    );
    return result.Parameter?.Value ?? '';
  } catch {
    return '';
  }
}

export async function addS3ToolsGatewayTarget(scope: Construct, gateway: IGateway): Promise<GatewayTarget | undefined> {
  const s3ToolsLambdaArn = await readAmplifyS3ToolsLambdaArn();
  if (!s3ToolsLambdaArn) {
    new cdk.CfnOutput(scope, 'S3ToolsGatewayTargetSkipped', {
      value: 'AMPLIFY_AGENT_STACK_NAME unset or its s3_tools_lambda_arn SSM parameter not published yet',
    });
    return undefined;
  }

  const s3ToolsLambda = lambda.Function.fromFunctionArn(scope, 'S3ToolsLambda', s3ToolsLambdaArn);

  // GatewayTarget.forLambda's LambdaTargetConfiguration.bind() calls
  // s3ToolsLambda.grantInvoke(gateway.role) — since both the imported Lambda
  // and the gateway's role resolve to the same AWS account, CDK's
  // Grant.addToPrincipalOrResource adds the lambda:InvokeFunction statement
  // directly to gateway.role's identity policy (same-account short-circuit)
  // without needing to touch the imported Lambda's resource policy at all.
  // credentialProviderConfigurations defaults to GATEWAY_IAM_ROLE, matching
  // the old custom resource's explicit GATEWAY_IAM_ROLE configuration.
  return GatewayTarget.forLambda(scope, 'S3ToolsGatewayTarget', {
    gateway,
    gatewayTargetName: 's3-tools',
    description: 'ApplyDiff/ListFiles/ReadFile/DeleteFile/UploadFile filesystem tools (issue #240)',
    lambdaFunction: s3ToolsLambda,
    toolSchema: ToolSchema.fromInline(S3_TOOL_DEFINITIONS),
  });
}
