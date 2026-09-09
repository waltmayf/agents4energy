import type { Gateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Duration, Stack } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Construct } from 'constructs';
import { LambdaGatewayTarget } from './lambdaGatewayTarget.cdk';
import { cfdToolsToolDefinitions } from './cfdToolsSchema';
import { readAmplifySsmParam } from './amplifySsm.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local copy of web/amplify/functions/cfd-tools/{handler,cfd-slurm-script,
// cfd-types}.ts — see gateway-targets/s3-tools/handler.ts's header comment
// for why this app keeps standalone copies rather than a cross-repo entry.
const CFD_TOOLS_HANDLER_ENTRY = resolve(__dirname, 'cfd-tools/handler.ts');

/**
 * Registers the cfd-tools Lambda (SubmitCfdSimulation/GetCfdJobStatus/
 * GetCfdResults, issue #504) as a Lambda-backed AgentCore Gateway target.
 * Moved from web/amplify/constructs/cfdToolsGatewayTarget + backend.ts
 * (#536). The AWS PCS + Slurm + FSx-Lustre cluster itself (epic #498 slice
 * 5, Amplify's `enableHpc`-gated `hpc-cluster` stack) stays in Amplify —
 * only the tool Lambda + gateway-target registration move here.
 *
 * Needs three Amplify-owned identifiers, read opportunistically from SSM
 * (`/agentcore/<amplifyStackName>/...` — see amplifySsm.cdk.ts): the login
 * node's EC2 Name tag (to find the head node to SSM-SendCommand against),
 * the HPC bucket name (FSx auto-exports job results here), and the shared
 * storage bucket name (GetCfdResults mirrors a summary into
 * files/artifacts/ for the /file route). No-ops when any of the three
 * isn't resolvable yet — Amplify's `hpc-cluster` stack is itself behind a
 * `-c enableHpc=true` context flag that defaults OFF, so on a normal
 * Amplify deploy these SSM params never exist and this target simply never
 * gets created (matches the outer `if (enableHpc)` gate this replaces).
 */
export async function addCfdToolsGatewayTarget(scope: Construct, gateway: Gateway): Promise<void> {
  const [headNodeTag, hpcBucketName, workspaceBucketName] = await Promise.all([
    readAmplifySsmParam('hpc/login_node_name_tag'),
    readAmplifySsmParam('hpc/hpc_bucket_name'),
    readAmplifySsmParam('storage_bucket_name'),
  ]);
  if (!headNodeTag || !hpcBucketName || !workspaceBucketName) return;

  const fn = new NodejsFunction(scope, 'CfdToolsFn', {
    entry: CFD_TOOLS_HANDLER_ENTRY,
    runtime: Runtime.NODEJS_20_X,
    timeout: Duration.seconds(60),
    environment: {
      HEAD_NODE_TAG: headNodeTag,
      HPC_BUCKET: hpcBucketName,
      WORKSPACE_BUCKET: workspaceBucketName,
    },
  });

  const { region, account } = Stack.of(scope);

  // DescribeInstances/GetCommandInvocation don't support resource-level
  // scoping (AWS docs: "* only"); SendCommand is scoped to the target
  // instances + the specific SSM document it's allowed to run.
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['ec2:DescribeInstances'],
    resources: ['*'],
  }));
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['ssm:SendCommand'],
    resources: [
      `arn:aws:ec2:${region}:${account}:instance/*`,
      `arn:aws:ssm:${region}::document/AWS-RunShellScript`,
    ],
  }));
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['ssm:GetCommandInvocation'],
    resources: ['*'],
  }));

  // FSx auto-exports job results to this bucket at cfd-simulations/<jobId>/results/.
  const hpcBucketArn = `arn:aws:s3:::${hpcBucketName}`;
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: [`${hpcBucketArn}/cfd-simulations/*`],
  }));
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [hpcBucketArn],
    conditions: { StringLike: { 's3:prefix': ['cfd-simulations/*'] } },
  }));

  // GetCfdResults mirrors a results summary into files/artifacts/ so it
  // renders via the /file artifact route (issue #501/#512).
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:PutObject'],
    resources: [`arn:aws:s3:::${workspaceBucketName}/files/artifacts/*`],
  }));

  fn.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: gateway.gatewayArn,
  });

  new LambdaGatewayTarget(scope, 'CfdToolsGatewayTarget', {
    gatewayIdentifier: gateway.gatewayId,
    gatewayArn: gateway.gatewayArn,
    targetName: 'cfd-tools',
    lambdaArn: fn.functionArn,
    toolDefinitions: cfdToolsToolDefinitions,
  });
}
