/**
 * Spike #533 — the two hardest checks for the standalone gateway-platform
 * epic (#532): does an AgentCore Gateway + CUSTOM_JWT authorizer synth as
 * raw CDK *inside* a Blocks app, and can its id/endpoint/ARN reach SSM for a
 * separate process to read? Gated behind AGENTCORE_GATEWAY_EXPERIMENT=1 so
 * it never runs during normal `npm run dev` / `npm run sandbox`.
 *
 * Mirrors web/amplify/constructs/agentCoreApplication.ts's createRequire
 * workaround (@aws/agentcore-cdk only declares a "require" export
 * condition) and the agentcore.json sentinel constraint
 * (AgentCoreMcp calls findConfigRoot(), which throws without one) — see
 * aws-blocks/agentcore/agentcore.json.
 */
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import type { AgentCoreMcp as AgentCoreMcpType, AgentCoreMcpSpec } from '@aws/agentcore-cdk';

const require = createRequire(import.meta.url);
const {
  AgentCoreMcp,
  setSessionProjectRoot,
}: typeof import('@aws/agentcore-cdk') = require('@aws/agentcore-cdk');

const __dirname = dirname(fileURLToPath(import.meta.url));
// AgentCoreMcp's constructor calls findConfigRoot() unconditionally — point
// it at aws-blocks/ (parent of agentcore/agentcore.json) the same way
// backend.ts points it at web/amplify/.
setSessionProjectRoot(__dirname);

export function addGatewayExperimentStack(app: cdk.App) {
  const stack = new cdk.Stack(app, 'gateway-blocks-poc-experiment');

  // ── Self-contained Cognito pool for the CUSTOM_JWT authorizer ──────────
  // A standalone gateway platform (per #532's vision) owns its own auth
  // boundary rather than importing the Amplify app's pool, so this spike
  // creates a fresh one via raw CDK instead of `fromExisting`.
  const userPool = new cognito.UserPool(stack, 'SpikeUserPool', {
    selfSignUpEnabled: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const userPoolClient = userPool.addClient('SpikeClient', {
    authFlows: { userPassword: true },
    generateSecret: false,
  });

  // ── MCP-server target endpoint: a minimal Lambda Function URL MCP server
  // (criterion 5 — resources/list / resources/read for steering docs) ─────
  const mockMcpServerFn = new NodejsFunction(stack, 'MockMcpServer', {
    entry: resolve(__dirname, 'mock-mcp-server-handler.ts'),
    runtime: lambda.Runtime.NODEJS_20_X,
    timeout: cdk.Duration.seconds(10),
  });
  const mockMcpServerUrl = mockMcpServerFn.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.NONE,
  });

  // ── Gateway + targets, declared entirely through AgentCoreMcpSpec ──────
  const mcpSpec: AgentCoreMcpSpec = {
    agentCoreGateways: [
      {
        name: 'spike-gateway',
        description: 'Spike #533 gateway — go/no-go gate for the standalone gateway-platform epic',
        targets: [
          // Criterion 4 — Lambda tool target, toolSchema.inlinePayload.
          {
            name: 'echoTool',
            targetType: 'lambda',
            compute: {
              host: 'Lambda',
              implementation: {
                language: 'Python',
                path: resolve(__dirname, 'agentcore/tools/echo'),
                handler: 'handler.handler',
              },
              pythonVersion: 'PYTHON_3_13',
            },
            toolDefinitions: [
              {
                name: 'echo',
                description: 'Echoes the input text back — spike #533 smoke-test tool.',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                },
              },
            ],
          },
          // Criterion 5 — MCP-server target (steering-doc resource fallback).
          {
            name: 'steeringDocsServer',
            targetType: 'mcpServer',
            endpoint: mockMcpServerUrl.url,
          },
        ],
        authorizerType: 'CUSTOM_JWT',
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: `https://cognito-idp.${stack.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
            allowedClients: [userPoolClient.userPoolClientId],
          },
        },
        enableSemanticSearch: false,
        exceptionLevel: 'DEBUG',
      },
    ],
  };

  const mcp: AgentCoreMcpType = new AgentCoreMcp(stack, 'Mcp', {
    projectName: 'gwSpike533',
    mcpSpec,
  });

  const gateway = mcp.gateways.get('spike-gateway');
  if (!gateway) throw new Error('Gateway "spike-gateway" not found after AgentCoreMcp synth');

  // ── Criterion 3 — publish gateway id/endpoint/ARN to SSM for a separate
  // process to read. Raw ssm.StringParameter (not the AppSetting block):
  // the gateway's attrs are same-stack CDK tokens produced by AgentCoreMcp,
  // a separate construct tree from any Blocks-managed Scope, so there's no
  // Blocks `scope` in hand here to hang an AppSetting off; the "separate
  // process" is any external SDK caller reading this literal path.
  const ssmPath = `/agentcore/${stack.stackName}/gateway`;
  new ssm.StringParameter(stack, 'GatewaySsmSettings', {
    parameterName: ssmPath,
    stringValue: JSON.stringify({
      gatewayId: gateway.attrGatewayIdentifier,
      gatewayArn: gateway.attrGatewayArn,
      gatewayUrl: gateway.attrGatewayUrl,
    }),
  });

  new cdk.CfnOutput(stack, 'GatewaySsmPath', { value: ssmPath });
  new cdk.CfnOutput(stack, 'GatewayId', { value: gateway.attrGatewayIdentifier });
  new cdk.CfnOutput(stack, 'GatewayArn', { value: gateway.attrGatewayArn });
  new cdk.CfnOutput(stack, 'GatewayUrl', { value: gateway.attrGatewayUrl });
  new cdk.CfnOutput(stack, 'UserPoolId', { value: userPool.userPoolId });
  new cdk.CfnOutput(stack, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  new cdk.CfnOutput(stack, 'MockMcpServerUrl', { value: mockMcpServerUrl.url });

  return stack;
}
