import type { Gateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Duration, Stack } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Construct } from 'constructs';
import { LambdaGatewayTarget } from './lambdaGatewayTarget.cdk';
import { athenaPySparkToolDefinitions } from './athenaPySparkSchema';
import { readAmplifySsmParam } from './amplifySsm.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local copy of web/amplify/functions/athena-pyspark/{handler,loadScript}.ts
// + python/*.py — see gateway-targets/s3-tools/handler.ts's header comment
// for why this app keeps standalone copies rather than a cross-repo entry.
const ATHENA_PYSPARK_HANDLER_ENTRY = resolve(__dirname, 'athena-pyspark/handler.ts');

/**
 * Registers the athena-pyspark Lambda (SubmitPySpark/GetPySparkStatus/
 * GetPySparkResults, issue #501) as a Lambda-backed AgentCore Gateway
 * target. Moved from web/amplify/constructs/athenaPySparkGatewayTarget +
 * backend.ts (#536). The Athena-for-Spark workgroup + Glue data lake + Spark
 * execution role themselves (epic #498 slice 2) stay in Amplify — only the
 * tool Lambda + gateway-target registration move here.
 *
 * Needs three Amplify-owned identifiers, read opportunistically from SSM
 * (`/agentcore/<amplifyStackName>/...` — see amplifySsm.cdk.ts) rather than
 * a CFN reference, since gateway-platform and Amplify are independently
 * deployed apps: the workgroup name, the storage bucket name, and the Spark
 * execution role ARN (`iam:PassRole` target — Athena's StartSession
 * synchronously checks the caller can pass that role). No-ops when any of
 * the three isn't resolvable yet (Amplify not deployed, or no AWS
 * credentials — e.g. the credential-free `test:synth` gate).
 */
export async function addAthenaPySparkGatewayTarget(scope: Construct, gateway: Gateway): Promise<void> {
  const [workgroupName, bucketName, executionRoleArn] = await Promise.all([
    readAmplifySsmParam('athena_pyspark_workgroup_name'),
    readAmplifySsmParam('storage_bucket_name'),
    readAmplifySsmParam('athena_pyspark_execution_role_arn'),
  ]);
  if (!workgroupName || !bucketName || !executionRoleArn) return;

  const fn = new NodejsFunction(scope, 'AthenaPySparkFn', {
    entry: ATHENA_PYSPARK_HANDLER_ENTRY,
    runtime: Runtime.NODEJS_20_X,
    // Athena-for-Spark session cold starts run 40-90s+; SubmitPySpark
    // bounded-waits for the session to reach IDLE before returning, so this
    // needs real headroom above that — it never blocks for the job itself
    // (that's what GetPySparkStatus/GetPySparkResults poll).
    timeout: Duration.seconds(180),
    environment: {
      ATHENA_PYSPARK_WORKGROUP_NAME: workgroupName,
      STORAGE_BUCKET_NAME: bucketName,
    },
    // The handler reads python/*.py at runtime (loadScript.ts) to build the
    // script injected into each Athena calculation — esbuild only bundles
    // JS/TS, so copy that directory into the bundle output explicitly.
    bundling: {
      nodeModules: ['@aws-sdk/client-athena'],
      commandHooks: {
        beforeBundling: () => [],
        beforeInstall: () => [],
        afterBundling: (inputDir, outputDir) => [
          `cp -r ${inputDir}/aws-blocks/gateway-targets/athena-pyspark/python ${outputDir}/python`,
        ],
      },
    },
  });

  const { region, account } = Stack.of(scope);

  fn.addToRolePolicy(new PolicyStatement({
    actions: [
      'athena:StartSession',
      'athena:GetSession',
      'athena:GetSessionStatus',
      'athena:ListSessions',
      'athena:StartCalculationExecution',
      'athena:GetCalculationExecution',
      'athena:GetCalculationExecutionStatus',
    ],
    resources: [`arn:aws:athena:${region}:${account}:workgroup/*`],
  }));

  // Athena assumes the Spark execution role (owned by Amplify) to run the
  // session on this Lambda's behalf — athena:StartSession requires the
  // caller to be able to pass that role.
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['iam:PassRole'],
    resources: [executionRoleArn],
  }));

  // The Lambda only reads (GetPySparkResults' stdout/stderr/result fetch and
  // artifacts listing) — the actual artifact writes happen under the Spark
  // execution role inside the session, not this Lambda.
  const bucketArn = `arn:aws:s3:::${bucketName}`;
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [bucketArn, `${bucketArn}/*`],
  }));

  // Read-only Glue Data Catalog access — the handler itself never calls Glue
  // (all catalog queries run inside the Athena session under the Spark
  // execution role), but StartSession's synchronous validation of the target
  // workgroup/session touches the catalog on the calling identity too.
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables'],
    resources: ['*'],
  }));

  fn.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: gateway.gatewayArn,
  });

  new LambdaGatewayTarget(scope, 'AthenaPySparkGatewayTarget', {
    gatewayIdentifier: gateway.gatewayId,
    gatewayArn: gateway.gatewayArn,
    targetName: 'athena-pyspark',
    lambdaArn: fn.functionArn,
    toolDefinitions: athenaPySparkToolDefinitions,
  });
}
