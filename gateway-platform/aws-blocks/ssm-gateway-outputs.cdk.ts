/**
 * SSM plumbing stub for the standalone gateway-platform epic (#532).
 *
 * The real AgentCore Gateway construct lands in #535. Until then this
 * publishes placeholder values under the SSM path convention consumers
 * (Amplify's `web/` app, other services) will read from once the gateway is
 * real — so the read-side contract (path + key names) is fixed now and
 * doesn't change shape out from under anyone in #535.
 *
 * Path convention: `/gateway-platform/<stackName>/gateway` — a single JSON
 * blob with keys `gatewayId`, `gatewayEndpoint`, `gatewayArn`. Mirrors the
 * `/agentcore/<stackName>/gateway` convention `web/` already uses (see
 * AGENTS.md "Key Constraints"), rooted under `/gateway-platform/` instead
 * since this app is a separate deployment, not part of the Amplify stack.
 *
 * Deliberately attaches to the existing `blocksStack` rather than creating a
 * second top-level `cdk.Stack`: the Blocks CLI's `sandbox:destroy`/`destroy`
 * scripts invoke `cdk destroy` without `--all` (unlike their `deploy`/
 * `sandbox` counterparts, which do pass `--all`), so a second top-level stack
 * makes `npm run destroy`/`sandbox:destroy` fail with "Since this app
 * includes more than a single stack, specify which stacks to use" — found
 * the hard way tearing down this slice's own real sandbox deploy. #535's
 * real gateway construct should keep this in mind if it's tempted to give
 * the gateway its own top-level stack (spike #533 did, but that spike never
 * exercised `npm run sandbox:destroy` against it).
 */
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export interface GatewayOutputsStub {
  gatewayId: string;
  gatewayEndpoint: string;
  gatewayArn: string;
}

export const PENDING_GATEWAY_OUTPUTS: GatewayOutputsStub = {
  gatewayId: 'PENDING-see-issue-535',
  gatewayEndpoint: 'PENDING-see-issue-535',
  gatewayArn: 'PENDING-see-issue-535',
};

export function addGatewayOutputs(scope: Construct, stackName: string, values: GatewayOutputsStub) {
  const ssmPath = `/gateway-platform/${stackName}/gateway`;
  new ssm.StringParameter(scope, 'GatewayOutputsSsmParameter', {
    parameterName: ssmPath,
    stringValue: JSON.stringify(values),
  });

  new cdk.CfnOutput(scope, 'GatewaySsmPath', { value: ssmPath });

  return ssmPath;
}
