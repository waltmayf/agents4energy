import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Mirror image of web/amplify/backend.ts's readGatewayPlatformSsmParam: reads
// Amplify's synth-time-published `/agentcore/<amplifyStackName>/...` SSM
// params via a plain AWS-SDK call, wrapped in try/catch and defaulting to ''
// on ANY failure (missing parameter, no credentials, no network, wrong
// region). This is a real JS string by the time gateway-target constructs
// are declared, not a CDK token or a CloudFormation dynamic reference — so
// each Lambda-backed gateway target below can gate on "is the value present"
// and this app still deploys standalone (and synths credential-free) whether
// or not Amplify has ever been deployed. See the identical rationale in
// backend.ts for why a CFN dynamic reference (StringParameter.
// valueForStringParameter) is the wrong tool here: it hard-fails the whole
// deploy if the parameter doesn't exist yet, which breaks the two apps'
// independence contract (#535/#536).
//
// AMPLIFY_STACK_NAME has no single deterministic value the way gateway-
// platform's own stack name does (a fixed Blocks project id + "-prod") —
// Amplify's `agentStack` is a CDK *nested* stack, and CloudFormation appends
// a run-specific suffix to nested stack physical names. The default below is
// the current live name of the `main` branch's nested agent stack (confirmed
// via `aws ssm get-parameters-by-path --path /agentcore`); it stays stable
// across ordinary `main` redeploys (CloudFormation keeps a nested stack's
// physical name across updates) but WILL change if that stack is ever fully
// torn down and recreated. Override via env var if that ever happens, or once
// there's a less fragile way to publish it (e.g. a fixed-name top-level SSM
// parameter written by Amplify itself, filed as a follow-up).
const AMPLIFY_STACK_NAME =
  process.env.AMPLIFY_STACK_NAME ?? 'amplify-web-main-sandbox-949a6d20d0-agent594D7D9F-XCD8FDPVMTTK';
const AMPLIFY_SSM_BASE = `/agentcore/${AMPLIFY_STACK_NAME}`;

export async function readAmplifySsmParam(suffix: string): Promise<string> {
  try {
    const ssm = new SSMClient({});
    const result = await ssm.send(new GetParameterCommand({ Name: `${AMPLIFY_SSM_BASE}/${suffix}` }));
    return result.Parameter?.Value ?? '';
  } catch {
    return '';
  }
}
