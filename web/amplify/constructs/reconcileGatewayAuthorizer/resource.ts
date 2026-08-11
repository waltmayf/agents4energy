import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ReconcileGatewayAuthorizerProps {
  /** Physical id of the AgentCore gateway to reconcile. */
  gatewayIdentifier: string;
  /** ARN of the gateway — scopes the handler's IAM grant. */
  gatewayArn: string;
  /** OIDC discovery URL of this stack's live Cognito user pool. */
  discoveryUrl: string;
  /** App client ids the gateway's JWT authorizer should trust. */
  allowedClients: string[];
  /**
   * A value that changes every synth (e.g. `Date.now().toString()`) so the
   * CustomResource re-runs its handler on every deploy — CloudFormation only
   * re-invokes a custom resource when a property changes.
   */
  nonce: string;
}

/**
 * Force an EXISTING AgentCore gateway's CUSTOM_JWT authorizer to be reconciled
 * to the current stack's Cognito user pool + app client on every deploy (issue
 * #328), via a CDK custom resource — same Provider + NodejsFunction pattern as
 * S3ToolsGatewayTarget.
 *
 * Why this exists: CloudFormation reads a gateway's discoveryUrl/allowedClients
 * only when the gateway is first CREATED, so the backend.ts override that
 * re-derives them from the live pool (added for #128) never lands on a gateway
 * that already exists. On the long-lived main deploy that froze the gateway on
 * a since-deleted pool, whose OIDC doc 404'd, breaking MCP OAuth discovery
 * (#328). UpdateGateway is the only way to change an existing gateway's
 * authorizer; the handler is idempotent (it no-ops when already reconciled) so
 * a steady-state redeploy makes no control-plane change.
 */
export class ReconcileGatewayAuthorizer extends Construct {
  constructor(scope: Construct, id: string, props: ReconcileGatewayAuthorizerProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      // Bundle the agentcore-control client explicitly — the SDK baked into the
      // Lambda runtime is too old for the current request shapes (same reason
      // as S3ToolsGatewayTarget).
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // GetGateway + UpdateGateway both support resource-level scoping to the
    // gateway ARN (see SyncCedarPolicies, which scopes GetGateway the same way).
    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'bedrock-agentcore:GetGateway',
        'bedrock-agentcore:UpdateGateway',
      ],
      resources: [props.gatewayArn],
    }));

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        GatewayIdentifier: props.gatewayIdentifier,
        DiscoveryUrl: props.discoveryUrl,
        AllowedClients: props.allowedClients,
        // Changing every synth so CloudFormation re-invokes the handler each
        // deploy — reconciliation must run against the current pool, not only
        // when this construct's inputs happen to change.
        Nonce: props.nonce,
      },
    });
  }
}
