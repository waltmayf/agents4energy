import type { Gateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Duration } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Construct } from 'constructs';
import { LambdaGatewayTarget } from './lambdaGatewayTarget.cdk';
import { s3ToolDefinitions } from './s3ToolsSchema';
import { readAmplifySsmParam } from './amplifySsm.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Entry is a LOCAL copy of web/amplify/functions/s3-tools/handler.ts (see
// ./s3-tools/handler.ts's header comment) rather than a cross-repo reference
// to the original: NodejsFunction requires `entry` to resolve under esbuild's
// own project root, and pointing it at web/ (a separate npm/pnpm project with
// its own lockfile and package.json "imports" map) fights that — esbuild
// there tries to invoke whichever package manager owns the nearest lockfile
// it finds, and web/'s is pnpm, which this app never installs (it's an npm
// project). Keeping a self-contained copy avoids that entirely and keeps
// gateway-platform deployable with nothing outside its own directory.
const S3_TOOLS_HANDLER_ENTRY = resolve(__dirname, 's3-tools/handler.ts');

/**
 * Registers the s3-tools Lambda (ApplyDiff/ListFiles/ReadFile/DeleteFile/
 * UploadFile, issue #240) as a Lambda-backed AgentCore Gateway target.
 * Moved from web/amplify/constructs/s3ToolsGatewayTarget + backend.ts (#536).
 *
 * The Lambda needs the Amplify Storage bucket's name — read opportunistically
 * from Amplify's `/agentcore/<amplifyStackName>/storage_bucket_name` SSM
 * param (see amplifySsm.cdk.ts). No CFN reference to the bucket itself is
 * possible (or wanted) since it lives in a different, independently deployed
 * CDK app; IAM grants below are built from the resolved bucket *name* string
 * instead of a bucket construct handle. Same-account identity-based S3
 * permissions are sufficient without any bucket-side resource policy change.
 * No-ops (returns without creating anything) when the bucket name isn't
 * resolvable yet (Amplify not deployed, or no AWS credentials — e.g. the
 * credential-free `test:synth` gate), mirroring the `if (AGENTCORE_GATEWAY_ID)`
 * gating pattern backend.ts uses for the reverse direction.
 */
export async function addS3ToolsGatewayTarget(scope: Construct, gateway: Gateway): Promise<void> {
  const bucketName = await readAmplifySsmParam('storage_bucket_name');
  if (!bucketName) return;

  const fn = new NodejsFunction(scope, 'S3ToolsFn', {
    entry: S3_TOOLS_HANDLER_ENTRY,
    runtime: Runtime.NODEJS_20_X,
    timeout: Duration.seconds(30),
    environment: { BUCKET_NAME: bucketName },
  });

  const bucketArn = `arn:aws:s3:::${bucketName}`;
  // Scoped to the files/ root prefix only — see web/lib/s3-fs-path.ts.
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${bucketArn}/files/*`],
  }));
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:PutObject', 's3:DeleteObject'],
    resources: [`${bucketArn}/files/*`],
  }));
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [bucketArn],
    conditions: { StringLike: { 's3:prefix': ['files/*'] } },
  }));

  // Resource-based permission letting the gateway service invoke the Lambda —
  // now a real same-app CDK token (gateway.gatewayArn), unlike the SSM-sourced
  // string Amplify had to fall back to before the target itself lived here.
  fn.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: gateway.gatewayArn,
  });

  new LambdaGatewayTarget(scope, 'S3ToolsGatewayTarget', {
    gatewayIdentifier: gateway.gatewayId,
    gatewayArn: gateway.gatewayArn,
    targetName: 's3-tools',
    lambdaArn: fn.functionArn,
    toolDefinitions: s3ToolDefinitions,
  });
}
