/**
 * AgentCore Gateway + CUSTOM_JWT authorizer, moved here from Amplify's
 * `agentStack` (web/amplify/backend.ts) as part of the standalone
 * gateway-platform epic (#532, this slice #535).
 *
 * Uses aws-cdk-lib's own `aws_bedrockagentcore` L2 constructs (`Gateway`,
 * `GatewayAuthorizer`) — shipped in aws-cdk-lib 2.257+, so this app doesn't
 * need a dependency on the alpha `@aws/agentcore-cdk` package (which is
 * Amplify-app-shaped: it assumes an `agentcore.json` sentinel directory
 * that has no meaning here).
 *
 * Cognito wiring (#535 guardrail): the Gateway's CUSTOM_JWT authorizer needs a
 * live, resolvable discoveryUrl + allowedClients at CREATE time — Amplify's
 * `ReconcileGatewayAuthorizer` custom resource (web/amplify/constructs/
 * reconcileGatewayAuthorizer) only self-heals an EXISTING gateway via
 * UpdateGateway; it can't satisfy CloudFormation's synchronous validation on
 * first create. So a real deploy of this app MUST pass the current Amplify
 * Cognito pool's discovery URL + trusted client ids via CDK context:
 *
 *   npx cdk deploy --context cognitoDiscoveryUrl=https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration \
 *                  --context cognitoAllowedClientIds=<browserClientId>,<serviceWebhookClientId>
 *
 * After that first create, Amplify's ReconcileGatewayAuthorizer keeps the
 * authorizer in sync with the live pool on every Amplify deploy (and on every
 * TrustedOAuthClient row change) via UpdateGateway — exactly as it already
 * does for the gateway Amplify used to own directly — so this app's own
 * context values only matter at first bootstrap, not on every redeploy.
 *
 * When no context is supplied (e.g. the credential-free `pnpm test:synth`
 * gate), placeholder values keep synth working; a real deploy without real
 * values would create a gateway whose authorizer rejects every JWT until
 * Amplify's next deploy reconciles it.
 */
import * as cdk from 'aws-cdk-lib';
import { Gateway, GatewayAuthorizer, GatewayExceptionLevel } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

// Gateway names must match `^([0-9a-zA-Z][-]?){1,48}$` (max 48 chars,
// alnum+hyphen, no leading/trailing/doubled hyphens) — tighter than the old
// Amplify-side `toGatewayResourceName` helper's 100-char cap, so re-derive it
// here rather than reuse that helper's slice length.
const sanitizeGatewayName = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');

export interface AgentCoreGatewayResult {
  gateway: Gateway;
}

export function addAgentCoreGateway(scope: Construct, stackName: string): AgentCoreGatewayResult {
  const app = scope.node.root as cdk.App;

  const cognitoDiscoveryUrl =
    (app.node.tryGetContext('cognitoDiscoveryUrl') as string | undefined) ??
    'https://pending.example.com/.well-known/openid-configuration';
  const cognitoAllowedClientIdsRaw = app.node.tryGetContext('cognitoAllowedClientIds') as string | undefined;
  const cognitoAllowedClientIds = cognitoAllowedClientIdsRaw
    ? cognitoAllowedClientIdsRaw.split(',').map((id) => id.trim()).filter(Boolean)
    : ['PENDING-see-issue-535'];

  const gateway = new Gateway(scope, 'AgentCoreGateway', {
    gatewayName: sanitizeGatewayName(stackName),
    description: `AgentCore Gateway for ${stackName}`,
    exceptionLevel: GatewayExceptionLevel.DEBUG,
    authorizerConfiguration: GatewayAuthorizer.usingCustomJwt({
      discoveryUrl: cognitoDiscoveryUrl,
      allowedClients: cognitoAllowedClientIds,
    }),
  });

  // Gateway targets are registered out-of-band from the Amplify side (SDK
  // CreateGatewayTarget calls against the gateway id read from SSM below —
  // see S3ToolsGatewayTarget/GraphTraverseGatewayTarget/etc in
  // web/amplify/backend.ts), so this app never knows the target Lambda ARNs
  // up front. CreateGatewayTarget synchronously validates that the gateway's
  // OWN execution role can invoke the target Lambda — Amplify can no longer
  // attach that grant itself now that this role lives in a different CDK app
  // (attaching to an imported cross-app role no-ops, see @aws/agentcore-cdk's
  // Gateway.js warning for the same situation). Grant account+region-wide
  // lambda:InvokeFunction here instead of a per-target grant; the real
  // authorization boundary stays at the gateway's own CUSTOM_JWT authorizer +
  // Cedar policy engine (tool-call level), not this IAM statement.
  gateway.role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:${cdk.Stack.of(scope).partition}:lambda:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:function:*`],
    }),
  );

  const ssmPath = `/gateway-platform/${stackName}/gateway`;
  new cdk.aws_ssm.StringParameter(scope, 'GatewayIdSsmParameter', {
    parameterName: `${ssmPath}/id`,
    stringValue: gateway.gatewayId,
  });
  new cdk.aws_ssm.StringParameter(scope, 'GatewayArnSsmParameter', {
    parameterName: `${ssmPath}/arn`,
    stringValue: gateway.gatewayArn,
  });
  // gatewayUrl is optional on IGateway (undefined for some protocol/auth
  // combinations); MCP gateways always populate it, but guard anyway since
  // an empty StringParameter value is rejected by CloudFormation.
  if (gateway.gatewayUrl) {
    new cdk.aws_ssm.StringParameter(scope, 'GatewayEndpointSsmParameter', {
      parameterName: `${ssmPath}/endpoint`,
      stringValue: gateway.gatewayUrl,
    });
  }

  new cdk.CfnOutput(scope, 'GatewaySsmPath', { value: ssmPath });
  new cdk.CfnOutput(scope, 'AgentCoreGatewayIdOutput', { value: gateway.gatewayId });
  new cdk.CfnOutput(scope, 'AgentCoreGatewayArnOutput', { value: gateway.gatewayArn });

  return { gateway };
}
