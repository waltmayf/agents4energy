/**
 * SSM plumbing stub for the standalone gateway-platform epic (#532).
 *
 * The real AgentCore Gateway construct lands in #535. Until then this stack
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
 */
import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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

export function addGatewayOutputsStack(app: cdk.App, stackName: string, values: GatewayOutputsStub) {
  const stack = new cdk.Stack(app, `${stackName}-gateway-outputs`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
    },
  });

  const ssmPath = `/gateway-platform/${stackName}/gateway`;
  new ssm.StringParameter(stack, 'GatewayOutputs', {
    parameterName: ssmPath,
    stringValue: JSON.stringify(values),
  });

  new cdk.CfnOutput(stack, 'GatewaySsmPath', { value: ssmPath });

  return stack;
}
