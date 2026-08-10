import { Construct } from 'constructs';
import { Duration, CustomResource, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface GraphTraverseMcpServerSeedProps {
  /** AppSync GraphQL endpoint URL. */
  graphqlUrl: string;
  /** AppSync API region, for SigV4 signing. */
  graphqlRegion: string;
  /** The AgentCore Gateway's MCP endpoint URL (the McpServer.url value). */
  gatewayEndpoint: string;
  /** AppSync GraphQL API id — scopes the handler's appsync:GraphQL grant to this API only. */
  graphqlApiId: string;
}

/**
 * Idempotently seeds a demo `Agent` + `McpServer` (pointing at the AgentCore
 * Gateway) + `AgentMcpServer` join row so the knowledge-graph `TraverseGraph`
 * tool (issue #291) is reachable end-to-end from the chat UI without any manual
 * setup. Mirrors web/amplify/constructs/s3ToolsMcpServerSeed — a CDK custom
 * resource writing to the Amplify Data (AppSync) API at deploy time via SigV4.
 */
export class GraphTraverseMcpServerSeed extends Construct {
  constructor(scope: Construct, id: string, props: GraphTraverseMcpServerSeedProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
    });

    // IAM principal calling AppSync directly (see handler.ts). This custom
    // resource lives in the same synth as the data stack, so it can be scoped
    // to the concrete API instead of apis/*.
    const { region, account } = Stack.of(this);
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['appsync:GraphQL'],
      resources: [
        `arn:aws:appsync:${region}:${account}:apis/${props.graphqlApiId}/types/Query/fields/*`,
        `arn:aws:appsync:${region}:${account}:apis/${props.graphqlApiId}/types/Mutation/fields/*`,
      ],
    }));

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        GraphqlUrl: props.graphqlUrl,
        GraphqlRegion: props.graphqlRegion,
        GatewayEndpoint: props.gatewayEndpoint,
      },
    });
  }
}
