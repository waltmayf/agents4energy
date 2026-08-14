import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Any Secrets Manager secret backing McpServer.oauthClientSecretArn MUST be
// created with a name under this prefix — that's how the handler's
// GetSecretValue grant is scoped without knowing concrete secret ARNs at
// synth time (each row's secret is created dynamically at runtime, e.g. by
// the epic #412 slice 7 MCP Servers UI, not by this stack). Keep this in sync
// with whatever creates those secrets.
export const MCP_OAUTH_CLIENT_SECRET_NAME_PREFIX = 'mcp-oauth-client-secret/';

export interface SyncOauthCredentialProviderProps {
  /** The MCP Server DynamoDB table — source of truth + stream trigger. */
  mcpServerTable: ITable;
}

/**
 * Stream-triggered Lambda that reconciles each `McpServer` row's outbound
 * OAuth2 config against an AgentCore Identity OAuth2 credential provider
 * (epic #412 slice 1, issue #413): creates one when a row first sets
 * `outboundAuthType: OAUTH_3LO` with a vendor/clientId/secret, updates it when
 * that config changes, and deletes it when the row is removed or the config
 * is turned back off. Persists the resulting `oauthProviderArn` and the
 * issued `oauthCallbackUrl` back onto the row so slice 3 (#415) can attach
 * the provider to the gateway target and slice 7 (#419) can surface the
 * callback URL to the operator. See
 * web/amplify/functions/sync-oauth-credential-provider/handler.ts for the
 * reconcile logic.
 *
 * Built as a raw NodejsFunction in its own stack (not an Amplify
 * `defineFunction`) for the same reason as RegisterMcpTargetOnMcpServer /
 * SyncCedarPolicies: it reads/writes the McpServer table via env, IAM, and a
 * DynamoEventSource, and a defineFunction living in Amplify's shared function
 * stack would close a `data → function → data` cycle CloudFormation rejects
 * at synth (#152).
 */
export class SyncOauthCredentialProvider extends Construct {
  constructor(scope: Construct, id: string, props: SyncOauthCredentialProviderProps) {
    super(scope, id);

    const fn = new NodejsFunction(this, 'Handler', {
      entry: resolve(__dirname, '../functions/sync-oauth-credential-provider/handler.ts'),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      environment: {
        MCP_SERVER_TABLE_NAME: props.mcpServerTable.tableName,
      },
      // NodejsFunction excludes @aws-sdk/* from the bundle by default on Node
      // 18+ runtimes, relying on the (older) SDK baked into the Lambda
      // runtime — which predates the Oauth2CredentialProvider APIs (same
      // reason as RegisterMcpTargetOnMcpServer / SyncCedarPolicies bundle this
      // client explicitly). Bundle it so the handler gets the version pinned
      // in package.json.
      bundling: { nodeModules: ['@aws-sdk/client-bedrock-agentcore-control'] },
    });

    // Create/Update/Delete/GetOauth2CredentialProvider identify the provider
    // only by a name this handler derives from the McpServer row's id — there
    // is no fixed resource ARN to scope to at synth time (same reasoning as
    // CreateGatewayTarget in RegisterMcpTargetOnMcpServer).
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock-agentcore:*Oauth2CredentialProvider'],
      resources: ['*'],
    }));

    // CreateOauth2CredentialProvider/UpdateOauth2CredentialProvider read an
    // EXTERNAL client secret using the caller's own credentials, so this
    // handler's role needs read access to whichever secret an McpServer row
    // points at via oauthClientSecretArn — scoped to the naming convention
    // above rather than every secret in the account.
    fn.addToRolePolicy(new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${Stack.of(this).region}:${Stack.of(this).account}:secret:${MCP_OAUTH_CLIENT_SECRET_NAME_PREFIX}*`,
      ],
    }));

    fn.addToRolePolicy(new PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [props.mcpServerTable.tableArn],
    }));

    fn.addEventSource(new DynamoEventSource(props.mcpServerTable, {
      startingPosition: StartingPosition.LATEST,
      batchSize: 1,
      retryAttempts: 3,
    }));
  }
}
