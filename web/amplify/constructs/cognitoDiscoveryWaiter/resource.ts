import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CognitoDiscoveryWaiterProps {
  /**
   * Cognito OpenID discovery URL to poll until it's live, e.g.
   * `https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/openid-configuration`.
   * May be a CDK token (resolved at deploy time).
   */
  discoveryUrl: string;
}

/**
 * Blocks deployment until a Cognito user pool's OpenID discovery document is
 * actually reachable (HTTP 200 with issuer/jwks_uri), not merely until the pool
 * resource reports CREATE_COMPLETE. The MCP Gateway's AgentCredentialProvider
 * fetches that document at create time and fails to stabilize if it races the
 * pool's propagation window on a first-ever deploy — see handler.ts. Add a
 * `node.addDependency(this)` from the gateway/AgentCore app so it waits.
 *
 * No IAM policy is attached: the discovery endpoint is a public, unauthenticated
 * URL, so the plain `fetch` in the handler needs no AWS permissions.
 */
export class CognitoDiscoveryWaiter extends Construct {
  constructor(scope: Construct, id: string, props: CognitoDiscoveryWaiterProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      // Bounded above the handler's own polling budget (~2 min) so the poll,
      // not the Lambda, is what surfaces a timeout.
      timeout: Duration.minutes(3),
    });

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        // Included so a changed URL (new pool) forces the waiter to re-run on update.
        DiscoveryUrl: props.discoveryUrl,
      },
    });
  }
}
