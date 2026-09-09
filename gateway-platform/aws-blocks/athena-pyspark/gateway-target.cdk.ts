/**
 * Registers the athena-pyspark Lambda (SubmitPySpark/GetPySparkStatus/
 * GetPySparkResults, issue #501) as a gateway target — moved here from
 * web/amplify/constructs/athenaPySparkGatewayTarget by #550, the third of
 * four Lambda-target migrations split from #536 (part of the standalone
 * gateway-platform epic, #532). Same shape as s3-tools/gateway-target.cdk.ts
 * (#548) and cfd-tools/gateway-target.cdk.ts (#549) — see those files' docs
 * for the full rationale on why the Lambda stays in Amplify and only the
 * target registration moves here.
 *
 * The Lambda itself stays in Amplify (web/amplify/functions/athena-pyspark)
 * — it reads the `AthenaPySparkWorkgroup` (issue #500) workgroup name and the
 * shared agent-workspace S3 bucket as same-synth CDK tokens, which only exist
 * in that app.
 *
 * Unlike cfd-tools, this target is NOT gated behind an `enableHpc`-equivalent
 * flag on the Amplify side — the athena-pyspark Lambda is created
 * unconditionally there (see backend.ts's "PYSPARK SUBMIT/POLL/RESULTS TOOL"
 * section), so the only reason this no-ops is the standard "Amplify hasn't
 * published its Lambda ARN yet" race, exactly like s3-tools.
 */
import * as cdk from 'aws-cdk-lib';
import { GatewayTarget, ToolSchema, type IGateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Construct } from 'constructs';
import { ATHENA_PYSPARK_TOOL_DEFINITIONS } from './tool-schema';

async function readAmplifyAthenaPySparkLambdaArn(): Promise<string> {
  const amplifyStackName = process.env.AMPLIFY_AGENT_STACK_NAME;
  if (!amplifyStackName) return '';
  try {
    const ssm = new SSMClient({});
    const result = await ssm.send(
      new GetParameterCommand({ Name: `/agentcore/${amplifyStackName}/athena_pyspark_lambda_arn` }),
    );
    return result.Parameter?.Value ?? '';
  } catch {
    return '';
  }
}

export async function addAthenaPySparkGatewayTarget(scope: Construct, gateway: IGateway): Promise<GatewayTarget | undefined> {
  const athenaPySparkLambdaArn = await readAmplifyAthenaPySparkLambdaArn();
  if (!athenaPySparkLambdaArn) {
    new cdk.CfnOutput(scope, 'AthenaPySparkGatewayTargetSkipped', {
      value: 'AMPLIFY_AGENT_STACK_NAME unset or its athena_pyspark_lambda_arn SSM parameter not published yet',
    });
    return undefined;
  }

  const athenaPySparkLambda = lambda.Function.fromFunctionArn(scope, 'AthenaPySparkLambda', athenaPySparkLambdaArn);

  // Same same-account grantInvoke short-circuit as S3ToolsGatewayTarget —
  // see that construct's identical comment.
  return GatewayTarget.forLambda(scope, 'AthenaPySparkGatewayTarget', {
    gateway,
    gatewayTargetName: 'athena-pyspark',
    description: 'SubmitPySpark/GetPySparkStatus/GetPySparkResults PySpark analytics tools (issue #501)',
    lambdaFunction: athenaPySparkLambda,
    toolSchema: ToolSchema.fromInline(ATHENA_PYSPARK_TOOL_DEFINITIONS),
  });
}
