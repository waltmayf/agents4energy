/**
 * Registers the cfd-tools Lambda (SubmitCfdSimulation/GetCfdJobStatus/
 * GetCfdResults, issue #504) as a gateway target — moved here from
 * web/amplify/constructs/cfdToolsGatewayTarget by #549, the second of four
 * Lambda-target migrations split from #536 (part of the standalone
 * gateway-platform epic, #532). Same shape as s3-tools/gateway-target.cdk.ts
 * (#548) — see that file's doc for the full rationale on why the Lambda
 * stays in Amplify and only the target registration moves here.
 *
 * The Lambda itself stays in Amplify (web/amplify/functions/cfd-tools) — it
 * reads `RealTimeParallelCluster` outputs (HPC login node tag, FSx-backed S3
 * bucket) as same-synth CDK tokens, which only exist in that app's
 * `hpc-cluster` stack.
 *
 * **HPC gating (`enableHpc`), preserved without a new gateway-platform
 * context flag**: web/amplify/backend.ts only creates the cfd-tools Lambda
 * (and publishes its ARN below) when deployed with `-c enableHpc=true` — a
 * normal Amplify deploy never creates the Lambda or the SSM parameter this
 * reads. So the existing "gateway-platform reads an SSM param that may not
 * exist yet, and skips the target if not" pattern (identical to s3-tools)
 * *is* the HPC gate here: no separate `enableHpc` context value needs to be
 * threaded into this app. If HPC was never enabled on the Amplify side (or
 * that Amplify stack hasn't deployed since #549), `/agentcore/<amplifyStackName>/
 * cfd_tools_lambda_arn` simply doesn't exist, GetParameterCommand throws, and
 * this target is skipped — same as the "gateway absent" no-op elsewhere in
 * this app.
 */
import * as cdk from 'aws-cdk-lib';
import { GatewayTarget, ToolSchema, type IGateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Construct } from 'constructs';
import { CFD_TOOL_DEFINITIONS } from './tool-schema';

async function readAmplifyCfdToolsLambdaArn(): Promise<string> {
  const amplifyStackName = process.env.AMPLIFY_AGENT_STACK_NAME;
  if (!amplifyStackName) return '';
  try {
    const ssm = new SSMClient({});
    const result = await ssm.send(
      new GetParameterCommand({ Name: `/agentcore/${amplifyStackName}/cfd_tools_lambda_arn` }),
    );
    return result.Parameter?.Value ?? '';
  } catch {
    return '';
  }
}

export async function addCfdToolsGatewayTarget(scope: Construct, gateway: IGateway): Promise<GatewayTarget | undefined> {
  const cfdToolsLambdaArn = await readAmplifyCfdToolsLambdaArn();
  if (!cfdToolsLambdaArn) {
    new cdk.CfnOutput(scope, 'CfdToolsGatewayTargetSkipped', {
      value: 'AMPLIFY_AGENT_STACK_NAME unset, HPC not enabled on that Amplify deploy, or its cfd_tools_lambda_arn SSM parameter not published yet',
    });
    return undefined;
  }

  const cfdToolsLambda = lambda.Function.fromFunctionArn(scope, 'CfdToolsLambda', cfdToolsLambdaArn);

  // Same same-account grantInvoke short-circuit as S3ToolsGatewayTarget —
  // see that construct's identical comment.
  return GatewayTarget.forLambda(scope, 'CfdToolsGatewayTarget', {
    gateway,
    gatewayTargetName: 'cfd-tools',
    description: 'SubmitCfdSimulation/GetCfdJobStatus/GetCfdResults CFD simulation tools (issue #504)',
    lambdaFunction: cfdToolsLambda,
    toolSchema: ToolSchema.fromInline(CFD_TOOL_DEFINITIONS),
  });
}
