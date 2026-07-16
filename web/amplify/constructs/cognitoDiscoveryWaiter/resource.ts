import { Construct } from 'constructs';
import { Duration, CustomResource, Stack } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CognitoDiscoveryWaiterProps {
  /** Cognito user pool ID, e.g., us-east-1_ABC123 */
  userPoolId: string;
}

/**
 * Custom resource that waits for the Cognito user pool discovery document to be
 * available. Used to avoid race conditions when a new user pool is created in
 * the same CloudFormation stack as a Bedrock AgentCore MCP Gateway.
 */
export class CognitoDiscoveryWaiter extends Construct {
  constructor(scope: Construct, id: string, props: CognitoDiscoveryWaiterProps) {
    super(scope, id);
    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(180),
    });

    // No IAM permissions needed – the handler just performs public HTTPS GET.

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    const discoveryUrl = `https://cognito-idp.${Stack.of(scope).region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`;

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        DiscoveryUrl: discoveryUrl,
      },
    });
  }
}
