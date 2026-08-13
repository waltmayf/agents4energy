import { Construct } from 'constructs';
import { Duration, CustomResource } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
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
  /** IaC-known app client ids the gateway's JWT authorizer should trust (unioned with TrustedOAuthClient rows at reconcile time). */
  allowedClients: string[];
  /**
   * A value that changes every synth (e.g. `Date.now().toString()`) so the
   * CustomResource re-runs its handler on every deploy — CloudFormation only
   * re-invokes a custom resource when a property changes.
   */
  nonce: string;
  /** Pool the primary app client belongs to — scopes the handler's Cognito IAM grant. */
  userPoolId: string;
  /** ARN of that pool. */
  userPoolArn: string;
  /** The primary (browser) app client whose callbackUrLs get the TrustedOAuthClient union. */
  primaryClientId: string;
  /** IaC-known callback URLs (unioned with TrustedOAuthClient rows at reconcile time). */
  baseCallbackUrls: string[];
  /** TrustedOAuthClient table (#412 slice 6) — source of extra allowed clients/callbacks, and the stream trigger for runtime reconcile. */
  trustedOAuthClientTable: ITable;
}

/**
 * Force an EXISTING AgentCore gateway's CUSTOM_JWT authorizer, and the
 * primary app client's callbackUrLs, to stay reconciled to the current
 * stack's Cognito user pool/client PLUS the runtime-configurable
 * TrustedOAuthClient table (#412 slice 6) — on every deploy (issue #328) AND
 * on every change to that table, via a CDK custom resource AND a DynamoDB
 * Stream trigger sharing the same handler — same Provider + NodejsFunction
 * pattern as S3ToolsGatewayTarget, same stream-reconcile pattern as
 * SyncCedarPolicies.
 *
 * Why the deploy-time half exists: CloudFormation reads a gateway's
 * discoveryUrl/allowedClients only when the gateway is first CREATED, so the
 * backend.ts override that re-derives them from the live pool (added for
 * #128) never lands on a gateway that already exists. UpdateGateway is the
 * only way to change an existing gateway's authorizer; the handler is
 * idempotent (it no-ops when already reconciled) so a steady-state redeploy
 * makes no control-plane change.
 *
 * Why the stream-triggered half exists: without it, adding/removing a
 * TrustedOAuthClient row only takes effect at the next `pnpm deploy` — the
 * exact "drift the next deploy clobbers" problem #412/#418 exists to fix, just
 * inverted (a manual UpdateGateway poke used to be the drift; now a
 * TrustedOAuthClient row is the durable source, and this stream keeps the
 * gateway/app-client caught up to it in near-real-time instead of only at
 * deploy time).
 */
export class ReconcileGatewayAuthorizer extends Construct {
  constructor(scope: Construct, id: string, props: ReconcileGatewayAuthorizerProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, 'handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: {
        GATEWAY_IDENTIFIER: props.gatewayIdentifier,
        DISCOVERY_URL: props.discoveryUrl,
        BASE_ALLOWED_CLIENTS: JSON.stringify(props.allowedClients),
        TRUSTED_OAUTH_CLIENT_TABLE_NAME: props.trustedOAuthClientTable.tableName,
        USER_POOL_ID: props.userPoolId,
        PRIMARY_CLIENT_ID: props.primaryClientId,
        BASE_CALLBACK_URLS: JSON.stringify(props.baseCallbackUrls),
      },
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

    fn.addToRolePolicy(new PolicyStatement({
      actions: [
        'cognito-idp:DescribeUserPoolClient',
        'cognito-idp:UpdateUserPoolClient',
      ],
      resources: [props.userPoolArn],
    }));

    fn.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:Scan'],
      resources: [props.trustedOAuthClientTable.tableArn],
    }));

    const provider = new Provider(this, 'Provider', {
      onEventHandler: fn,
    });

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        // The only property CloudFormation needs — everything the handler
        // reads comes from environment variables (see handler.ts), shared
        // with the stream-triggered path below. Changing every synth so
        // CloudFormation re-invokes the handler each deploy — reconciliation
        // must run against the current pool/table, not only when this
        // construct's inputs happen to change.
        Nonce: props.nonce,
      },
    });

    // Reconcile immediately when a TrustedOAuthClient row is added, edited, or
    // removed — the whole point of #412/#418 — rather than only at the next
    // deploy. batchSize:1 is about reacting promptly, not correctness: the
    // handler always re-scans the whole table (see reconcile.ts).
    fn.addEventSource(new DynamoEventSource(props.trustedOAuthClientTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 1,
      retryAttempts: 3,
    }));
  }
}
