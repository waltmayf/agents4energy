import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface S3ToolsMcpServerSeedProps {
  /** AppSync GraphQL endpoint URL. */
  graphqlUrl: string;
  /** AppSync API region, for SigV4 signing. */
  graphqlRegion: string;
  /** The AgentCore Gateway's MCP endpoint URL (the McpServer.url value). */
  gatewayEndpoint: string;
}

/**
 * Idempotently seeds a demo `Agent` + `McpServer` (pointing at the AgentCore
 * Gateway) + `AgentMcpServer` join row, so the S3 filesystem tools (issue
 * #240) are reachable end-to-end from the chat UI without any manual setup.
 * Out of scope per the issue: seeding actual `files/docs/...` content — this
 * only proves the wiring path.
 *
 * A CDK custom resource is used because this is a one-time/idempotent write
 * to the Amplify Data (AppSync) API at deploy time, not something CloudFormation
 * has a native resource for. The handler is a plain IAM principal (not a
 * Cognito user), so it calls AppSync directly over HTTPS with SigV4 signing —
 * same approach as agent/default/app/ClaudeCode/active-run.js.
 */
export class S3ToolsMcpServerSeed extends Construct {
  constructor(scope: Construct, id: string, props: S3ToolsMcpServerSeedProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
    });

    // IAM principal calling AppSync directly (see handler.ts) — matches the
    // grant shape at backend.ts's ClaudeCode runtime AppSync policy.
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['appsync:GraphQL'],
      resources: [
        'arn:aws:appsync:*:*:apis/*/types/Query/fields/*',
        'arn:aws:appsync:*:*:apis/*/types/Mutation/fields/*',
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
