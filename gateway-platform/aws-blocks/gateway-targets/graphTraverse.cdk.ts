import type { Gateway } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Duration, Stack } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { Construct } from 'constructs';
import { LambdaGatewayTarget } from './lambdaGatewayTarget.cdk';
import { graphTraverseToolDefinitions } from './graphTraverseSchema';
import { readAmplifySsmParam } from './amplifySsm.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Local copy of web/amplify/functions/graph-traverse/handler.ts — see
// gateway-targets/s3-tools/handler.ts's header comment for why this app
// keeps a standalone copy rather than a cross-repo entry path.
const GRAPH_TRAVERSE_HANDLER_ENTRY = resolve(__dirname, 'graph-traverse/handler.ts');

/**
 * Registers the graph-traverse Lambda (TraverseGraph/UpsertNode/UpsertEdge,
 * issue #291/#292) as a Lambda-backed AgentCore Gateway target. Moved from
 * web/amplify/constructs/graphTraverseGatewayTarget + backend.ts (#536).
 *
 * The Lambda reads/writes the Amplify AppSync API's Node/Edge models over
 * IAM-signed GraphQL (SigV4) — no CFN reference to the AppSync API is
 * possible (or wanted) since it lives in a different, independently
 * deployed CDK app. The GraphQL endpoint + api id are read opportunistically
 * from Amplify's `/agentcore/<amplifyStackName>/graphql_{url,api_id}` SSM
 * params (see amplifySsm.cdk.ts); the IAM grant below is built from the
 * resolved api id string. AppSync's IAM auth checks the CALLER's identity
 * policy only (no resource-policy change needed on the API itself), so a
 * same-account identity-based `appsync:GraphQL` grant is sufficient. No-ops
 * when the GraphQL coordinates aren't resolvable yet (Amplify not deployed,
 * or no AWS credentials — e.g. the credential-free `test:synth` gate).
 */
export async function addGraphTraverseGatewayTarget(scope: Construct, gateway: Gateway): Promise<void> {
  const [graphqlUrl, graphqlApiId] = await Promise.all([
    readAmplifySsmParam('graphql_url'),
    readAmplifySsmParam('graphql_api_id'),
  ]);
  if (!graphqlUrl || !graphqlApiId) return;

  const fn = new NodejsFunction(scope, 'GraphTraverseFn', {
    entry: GRAPH_TRAVERSE_HANDLER_ENTRY,
    runtime: Runtime.NODEJS_20_X,
    timeout: Duration.seconds(30),
    environment: {
      GRAPHQL_URL: graphqlUrl,
      GRAPHQL_REGION: Stack.of(scope).region,
    },
  });

  // Query-only would leave UpsertNode/UpsertEdge silently no-op'd (AppSync
  // returns an authorization error) — grant Mutation fields too.
  const { region, account } = Stack.of(scope);
  fn.addToRolePolicy(new PolicyStatement({
    actions: ['appsync:GraphQL'],
    resources: [
      `arn:aws:appsync:${region}:${account}:apis/${graphqlApiId}/types/Query/fields/*`,
      `arn:aws:appsync:${region}:${account}:apis/${graphqlApiId}/types/Mutation/fields/*`,
    ],
  }));

  fn.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: gateway.gatewayArn,
  });

  new LambdaGatewayTarget(scope, 'GraphTraverseGatewayTarget', {
    gatewayIdentifier: gateway.gatewayId,
    gatewayArn: gateway.gatewayArn,
    targetName: 'graph-traverse',
    lambdaArn: fn.functionArn,
    toolDefinitions: graphTraverseToolDefinitions,
  });
}
