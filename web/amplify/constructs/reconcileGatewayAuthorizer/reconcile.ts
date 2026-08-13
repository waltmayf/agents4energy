import {
  BedrockAgentCoreControlClient,
  GetGatewayCommand,
  UpdateGatewayCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const controlClient = new BedrockAgentCoreControlClient({});
const cognitoClient = new CognitoIdentityProviderClient({});
const ddb = new DynamoDBClient({});

export interface ReconcileInput {
  /** Physical id of the AgentCore gateway to reconcile. */
  gatewayIdentifier: string;
  /** OIDC discovery URL of this stack's live Cognito user pool. */
  discoveryUrl: string;
  /** IaC-known app client ids (primary browser client + service-webhook client). */
  baseAllowedClients: string[];
  /** TrustedOAuthClient table — the runtime source of EXTRA allowed clients/callbacks. */
  trustedOAuthClientTableName: string;
  /** Pool the primary app client belongs to. */
  userPoolId: string;
  /** The primary (browser) app client whose callbackUrLs get the data-driven union. */
  primaryClientId: string;
  /** IaC-known callback URLs (e.g. the local MCP OAuth callback). */
  baseCallbackUrls: string[];
}

interface TrustedOAuthClientRow {
  clientId?: string;
  callbackUrl?: string;
  enabled?: boolean;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

async function scanTrustedClients(tableName: string): Promise<{ clientIds: string[]; callbackUrls: string[] }> {
  const clientIds: string[] = [];
  const callbackUrls: string[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    for (const item of res.Items ?? []) {
      const row = unmarshall(item) as TrustedOAuthClientRow;
      // A disabled row keeps its metadata but drops out of both derived sets —
      // lets an admin revoke trust without deleting the row (see federation.schema.ts).
      if (row.enabled === false) continue;
      if (row.clientId) clientIds.push(row.clientId);
      if (row.callbackUrl) callbackUrls.push(row.callbackUrl);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { clientIds, callbackUrls };
}

/**
 * Reconcile the gateway's CUSTOM_JWT authorizer to `desiredAllowedClients`.
 *
 * UpdateGateway is a full-replacement PUT: name/roleArn/protocolType/
 * protocolConfiguration must be supplied or they reset. We GetGateway first
 * and echo the existing values back, overriding only the authorizer. If the
 * authorizer already matches, we skip the write so a no-op reconcile (most
 * deploys, most stream events) makes no control-plane change.
 */
async function reconcileGateway(
  gatewayIdentifier: string,
  discoveryUrl: string,
  desiredAllowedClients: string[],
): Promise<void> {
  const current = await controlClient.send(new GetGatewayCommand({ gatewayIdentifier }));

  const existing = current.authorizerConfiguration?.customJWTAuthorizer;
  const matches =
    !!existing &&
    existing.discoveryUrl === discoveryUrl &&
    JSON.stringify(uniqueSorted(existing.allowedClients ?? [])) === JSON.stringify(desiredAllowedClients);

  if (current.authorizerType === 'CUSTOM_JWT' && matches) {
    return;
  }

  if (!current.name || !current.roleArn) {
    throw new Error(
      `GetGateway for ${gatewayIdentifier} returned no name/roleArn; cannot safely UpdateGateway`,
    );
  }

  await controlClient.send(
    new UpdateGatewayCommand({
      gatewayIdentifier,
      name: current.name,
      roleArn: current.roleArn,
      description: current.description,
      protocolType: current.protocolType,
      protocolConfiguration: current.protocolConfiguration,
      // Note SDK casing is customJWTAuthorizer (capital JWT), unlike the
      // @aws/agentcore-cdk customJwtAuthorizer.
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl,
          allowedClients: desiredAllowedClients,
        },
      },
    }),
  );
}

/**
 * Reconcile the primary app client's callbackUrLs to `desiredCallbackUrls`.
 *
 * Like UpdateGateway, UpdateUserPoolClient resets any field you omit to its
 * default (per the SDK's per-field "if you don't specify..." documented
 * defaults) rather than leaving it unchanged — so we DescribeUserPoolClient
 * first and echo every current setting back, overriding only CallbackURLs.
 */
async function reconcileUserPoolClientCallbacks(
  userPoolId: string,
  clientId: string,
  desiredCallbackUrls: string[],
): Promise<void> {
  const { UserPoolClient: current } = await cognitoClient.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
  );
  if (!current) {
    throw new Error(`DescribeUserPoolClient for ${clientId} returned no client; cannot safely UpdateUserPoolClient`);
  }

  if (JSON.stringify(uniqueSorted(current.CallbackURLs ?? [])) === JSON.stringify(desiredCallbackUrls)) {
    return;
  }

  // ClientSecret/CreationDate/LastModifiedDate are read-only on
  // DescribeUserPoolClient's response and not accepted by UpdateUserPoolClient.
  const { ClientSecret, CreationDate, LastModifiedDate, ...updatable } = current;
  await cognitoClient.send(
    new UpdateUserPoolClientCommand({
      ...updatable,
      UserPoolId: userPoolId,
      ClientId: clientId,
      CallbackURLs: desiredCallbackUrls,
    }),
  );
}

/**
 * Full reconcile: scan TrustedOAuthClient for the extra allowed clients and
 * callback URLs, union each with its IaC-known base set, and push the result
 * to the gateway authorizer and the primary app client — idempotently (each
 * sub-reconcile diffs against the live value and writes only on change).
 *
 * Called both from the deploy-time CustomResource handler and from the
 * TrustedOAuthClient DynamoDB Stream handler — the stream record's contents
 * are never used, only its arrival as a "something changed" signal; this
 * always re-scans the whole table, so a batch edit or a missed/retried event
 * can never leave the gateway/app-client out of sync with the table.
 */
export async function reconcile(input: ReconcileInput): Promise<void> {
  const { clientIds: extraClientIds, callbackUrls: extraCallbackUrls } = await scanTrustedClients(
    input.trustedOAuthClientTableName,
  );

  const desiredAllowedClients = uniqueSorted([...input.baseAllowedClients, ...extraClientIds]);
  await reconcileGateway(input.gatewayIdentifier, input.discoveryUrl, desiredAllowedClients);

  const desiredCallbackUrls = uniqueSorted([...input.baseCallbackUrls, ...extraCallbackUrls]);
  await reconcileUserPoolClientCallbacks(input.userPoolId, input.primaryClientId, desiredCallbackUrls);
}
