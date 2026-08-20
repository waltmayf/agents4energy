import { DynamoDBStreamHandler } from 'aws-lambda';
import { AttributeValue, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  UpdateOauth2CredentialProviderCommand,
  DeleteOauth2CredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  CredentialProviderVendorType,
  SecretSourceType,
  type Oauth2ProviderConfigInput,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { resolveRegistrationEndpoint, registerClient, deleteClientRegistration } from './dcr';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MCP_SERVER_TABLE_NAME = process.env.MCP_SERVER_TABLE_NAME!;
// Naming-convention prefix under which this handler creates the Secrets Manager
// secrets it manages (client secret + RFC 7592 registration token). Must match
// the IAM grant scope in syncOauthCredentialProvider.ts.
const SECRET_NAME_PREFIX = process.env.SECRET_NAME_PREFIX ?? 'mcp-oauth-client-secret/';

const controlClient = new BedrockAgentCoreControlClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const secretsClient = new SecretsManagerClient({ region: REGION });

// The JSON key under which the client secret value must be stored in the
// Secrets Manager secret referenced by McpServer.oauthClientSecretArn — i.e.
// the secret value is `{ "clientSecret": "<value>" }`. Whatever creates that
// secret (epic #412 slice 7, the MCP Servers UI) must follow this convention.
const CLIENT_SECRET_JSON_KEY = 'clientSecret';
// JSON key for the RFC 7592 registration access token secret this handler writes.
const REGISTRATION_TOKEN_JSON_KEY = 'registrationAccessToken';
// Placeholder client_id used when creating the CustomOauth2 provider before DCR
// yields the real one — the create call only needs *a* value here; the real
// client_id is swapped in via UpdateOauth2CredentialProvider once /register
// returns. See the AWS-runtime assumption noted in the #449 PR body.
const PLACEHOLDER_CLIENT_ID = 'pending-dynamic-registration';

interface McpServerRecord {
  id: string;
  name?: string;
  outboundAuthType?: 'NONE' | 'OAUTH_3LO';
  oauthVendor?: 'GOOGLE' | 'CUSTOM';
  oauthClientId?: string;
  oauthClientSecretArn?: string;
  oauthDiscoveryUrl?: string;
  oauthProviderArn?: string;
  oauthCallbackUrl?: string;
  oauthScopes?: string[];
  // --- Dynamic Client Registration (RFC 7591), #449 ---
  oauthDynamicRegistration?: boolean;
  oauthRegistrationEndpoint?: string;
  oauthClientName?: string;
  oauthSoftwareStatement?: string;
  oauthInitialAccessTokenArn?: string;
  oauthRegistrationClientUri?: string;
  oauthRegistrationAccessTokenArn?: string;
  oauthError?: string;
}

function unmarshalItem(image: unknown): McpServerRecord | undefined {
  if (!image) return undefined;
  return unmarshall(image as unknown as Record<string, AttributeValue>) as McpServerRecord;
}

// AgentCore Identity OAuth2 credential provider names must be unique within
// the account; deriving one from the row's id makes create/update/delete
// idempotent across retried stream batches for the same row.
function providerName(mcpServerId: string): string {
  return `mcp-${mcpServerId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

interface BuiltConfig {
  vendor: CredentialProviderVendorType;
  config: Oauth2ProviderConfigInput;
}

// Returns undefined when the row isn't fully configured yet (e.g. the user
// hasn't saved a client secret) rather than throwing — that's a normal
// transient state while a row is being edited, not an error.
function buildProviderConfig(item: McpServerRecord): BuiltConfig | undefined {
  const { oauthVendor, oauthClientId, oauthClientSecretArn } = item;
  if (!oauthClientId || !oauthClientSecretArn) return undefined;

  const clientSecretConfig = { secretId: oauthClientSecretArn, jsonKey: CLIENT_SECRET_JSON_KEY };

  if (oauthVendor === 'GOOGLE') {
    return {
      vendor: CredentialProviderVendorType.GoogleOauth2,
      config: {
        googleOauth2ProviderConfig: {
          clientId: oauthClientId,
          clientSecretConfig,
          clientSecretSource: SecretSourceType.EXTERNAL,
        },
      },
    };
  }

  if (oauthVendor === 'CUSTOM') {
    if (!item.oauthDiscoveryUrl) return undefined;
    return {
      vendor: CredentialProviderVendorType.CustomOauth2,
      config: {
        customOauth2ProviderConfig: {
          oauthDiscovery: { discoveryUrl: item.oauthDiscoveryUrl },
          clientId: oauthClientId,
          clientSecretConfig,
          clientSecretSource: SecretSourceType.EXTERNAL,
        },
      },
    };
  }

  return undefined;
}

// Compares only the fields that feed buildProviderConfig, so a save that
// touches unrelated columns (e.g. renaming the server) doesn't re-call
// Update against a provider that's already in sync.
function configUnchanged(oldItem: McpServerRecord | undefined, item: McpServerRecord): boolean {
  return (
    !!oldItem &&
    oldItem.oauthVendor === item.oauthVendor &&
    oldItem.oauthClientId === item.oauthClientId &&
    oldItem.oauthClientSecretArn === item.oauthClientSecretArn &&
    oldItem.oauthDiscoveryUrl === item.oauthDiscoveryUrl
  );
}

async function deleteProvider(name: string): Promise<void> {
  try {
    await controlClient.send(new DeleteOauth2CredentialProviderCommand({ name }));
  } catch (err) {
    if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
  }
}

async function clearOauthFields(id: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: MCP_SERVER_TABLE_NAME,
    Key: { id: { S: id } },
    UpdateExpression: 'REMOVE oauthProviderArn, oauthCallbackUrl',
  }));
}

async function writeBackProvider(
  id: string,
  credentialProviderArn: string,
  callbackUrl: string | undefined,
): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: MCP_SERVER_TABLE_NAME,
    Key: { id: { S: id } },
    UpdateExpression: callbackUrl
      ? 'SET oauthProviderArn = :arn, oauthCallbackUrl = :cb'
      : 'SET oauthProviderArn = :arn',
    ExpressionAttributeValues: {
      ':arn': { S: credentialProviderArn },
      ...(callbackUrl ? { ':cb': { S: callbackUrl } } : {}),
    },
  }));
}

// Create the secret if absent, otherwise overwrite its value. Returns the ARN.
// Secret names must live under SECRET_NAME_PREFIX so the handler's IAM grant
// (scoped to that prefix) covers them.
async function upsertSecret(name: string, secretString: string): Promise<string> {
  try {
    const created = await secretsClient.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: secretString,
        Tags: [{ Key: 'a4e:managed-by', Value: 'sync-oauth-credential-provider' }],
      }),
    );
    return created.ARN!;
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceExistsException') {
      const put = await secretsClient.send(
        new PutSecretValueCommand({ SecretId: name, SecretString: secretString }),
      );
      return put.ARN!;
    }
    throw err;
  }
}

// The CustomOauth2 provider config used both for the placeholder create and the
// post-registration update — only the clientId differs between the two calls.
function customProviderConfig(discoveryUrl: string, clientId: string, secretArn: string): Oauth2ProviderConfigInput {
  return {
    customOauth2ProviderConfig: {
      oauthDiscovery: { discoveryUrl },
      clientId,
      clientSecretConfig: { secretId: secretArn, jsonKey: CLIENT_SECRET_JSON_KEY },
      clientSecretSource: SecretSourceType.EXTERNAL,
    },
  };
}

async function readSecretJsonValue(secretArn: string, jsonKey: string): Promise<string | undefined> {
  const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!res.SecretString) return undefined;
  try {
    const parsed = JSON.parse(res.SecretString) as Record<string, unknown>;
    const value = parsed[jsonKey];
    return typeof value === 'string' ? value : undefined;
  } catch {
    // Fall back to treating the whole SecretString as the raw value.
    return res.SecretString;
  }
}

async function recordDcrError(id: string, message: string): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: MCP_SERVER_TABLE_NAME,
    Key: { id: { S: id } },
    UpdateExpression: 'SET oauthError = :e',
    ExpressionAttributeValues: { ':e': { S: message.slice(0, 1000) } },
  }));
}

// Single write-back of everything DCR resolved, clearing any prior oauthError.
// Also sets outboundAuthType=OAUTH_3LO and oauthVendor=CUSTOM so the normal
// sync path (and register-mcp-target-stream) picks the row up on the resulting
// MODIFY and attaches the provider to the gateway target.
async function writeBackDcr(id: string, fields: {
  oauthClientId: string;
  oauthClientSecretArn: string;
  oauthProviderArn: string;
  oauthCallbackUrl: string;
  oauthRegistrationClientUri?: string;
  oauthRegistrationAccessTokenArn?: string;
}): Promise<void> {
  const sets = [
    'outboundAuthType = :auth',
    'oauthVendor = :vendor',
    'oauthClientId = :cid',
    'oauthClientSecretArn = :csa',
    'oauthProviderArn = :arn',
    'oauthCallbackUrl = :cb',
  ];
  const values: Record<string, AttributeValue> = {
    ':auth': { S: 'OAUTH_3LO' },
    ':vendor': { S: 'CUSTOM' },
    ':cid': { S: fields.oauthClientId },
    ':csa': { S: fields.oauthClientSecretArn },
    ':arn': { S: fields.oauthProviderArn },
    ':cb': { S: fields.oauthCallbackUrl },
  };
  if (fields.oauthRegistrationClientUri) {
    sets.push('oauthRegistrationClientUri = :rcu');
    values[':rcu'] = { S: fields.oauthRegistrationClientUri };
  }
  if (fields.oauthRegistrationAccessTokenArn) {
    sets.push('oauthRegistrationAccessTokenArn = :rta');
    values[':rta'] = { S: fields.oauthRegistrationAccessTokenArn };
  }
  await ddb.send(new UpdateItemCommand({
    TableName: MCP_SERVER_TABLE_NAME,
    Key: { id: { S: id } },
    UpdateExpression: `SET ${sets.join(', ')} REMOVE oauthError`,
    ExpressionAttributeValues: values,
  }));
}

// Provider-first + Update ordering (#449) — self-register this app as an OAuth
// client so no operator has to paste a client_id/secret:
//   1. ensure a placeholder client-secret secret exists (the CustomOauth2
//      provider references it via EXTERNAL source);
//   2. create the provider with a PLACEHOLDER client_id to obtain AgentCore's
//      per-provider callbackUrl (reused if a prior attempt already created it);
//   3. resolve the RFC 7591 registration_endpoint;
//   4. POST /register with redirect_uris=[callbackUrl];
//   5. store the issued client_secret (and RFC 7592 registration token);
//   6. UpdateOauth2CredentialProvider with the real client_id;
//   7. write oauthClientId/secretArn/providerArn/etc. back onto the row.
// On any failure: record oauthError on the row and delete the placeholder
// provider so we never leave a half-created one behind.
async function performDynamicRegistration(item: McpServerRecord): Promise<void> {
  const name = providerName(item.id);
  const clientSecretName = `${SECRET_NAME_PREFIX}${name}`;
  try {
    if (!item.oauthDiscoveryUrl) {
      throw new Error('oauthDynamicRegistration requires oauthDiscoveryUrl (the CustomOauth2 provider needs it)');
    }

    // 1. Placeholder client-secret secret so the provider can be created.
    const clientSecretArn = await upsertSecret(
      clientSecretName,
      JSON.stringify({ [CLIENT_SECRET_JSON_KEY]: 'pending-dynamic-registration' }),
    );

    // 2. Create (or reuse) the provider to obtain the callbackUrl.
    let providerArn: string | undefined;
    let callbackUrl: string | undefined;
    const existing = await controlClient
      .send(new GetOauth2CredentialProviderCommand({ name }))
      .catch((err) => {
        if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
        throw err;
      });
    if (existing?.credentialProviderArn) {
      providerArn = existing.credentialProviderArn;
      callbackUrl = existing.callbackUrl;
    } else {
      const created = await controlClient.send(new CreateOauth2CredentialProviderCommand({
        name,
        credentialProviderVendor: CredentialProviderVendorType.CustomOauth2,
        oauth2ProviderConfigInput: customProviderConfig(item.oauthDiscoveryUrl, PLACEHOLDER_CLIENT_ID, clientSecretArn),
      }));
      providerArn = created.credentialProviderArn;
      callbackUrl = created.callbackUrl;
    }
    if (!providerArn || !callbackUrl) {
      throw new Error('CreateOauth2CredentialProvider did not return a providerArn/callbackUrl');
    }

    // 3. Resolve the RFC 7591 registration endpoint.
    const registrationEndpoint = await resolveRegistrationEndpoint({
      discoveryUrl: item.oauthDiscoveryUrl,
      explicitEndpoint: item.oauthRegistrationEndpoint,
    });

    // Optional initial access token (Bearer) required by some ASes to register.
    let initialAccessToken: string | undefined;
    if (item.oauthInitialAccessTokenArn) {
      initialAccessToken = await readSecretJsonValue(item.oauthInitialAccessTokenArn, 'initialAccessToken');
    }

    // 4. Register.
    const reg = await registerClient({
      registrationEndpoint,
      initialAccessToken,
      request: {
        redirectUris: [callbackUrl],
        grantTypes: ['authorization_code'],
        scope: (item.oauthScopes ?? []).join(' ') || undefined,
        clientName: item.oauthClientName || item.name,
        softwareStatement: item.oauthSoftwareStatement,
      },
    });

    // 5. Store the real client secret + RFC 7592 registration token.
    if (reg.clientSecret) {
      await secretsClient.send(new PutSecretValueCommand({
        SecretId: clientSecretArn,
        SecretString: JSON.stringify({ [CLIENT_SECRET_JSON_KEY]: reg.clientSecret }),
      }));
    }
    let registrationAccessTokenArn: string | undefined;
    if (reg.registrationAccessToken) {
      registrationAccessTokenArn = await upsertSecret(
        `${clientSecretName}-registration`,
        JSON.stringify({ [REGISTRATION_TOKEN_JSON_KEY]: reg.registrationAccessToken }),
      );
    }

    // 6. Swap the placeholder client_id for the real one.
    await controlClient.send(new UpdateOauth2CredentialProviderCommand({
      name,
      credentialProviderVendor: CredentialProviderVendorType.CustomOauth2,
      oauth2ProviderConfigInput: customProviderConfig(item.oauthDiscoveryUrl, reg.clientId, clientSecretArn),
    }));

    // 7. Persist. This MODIFY re-triggers the stream, where DCR is skipped
    //    (oauthClientId now set) and the normal sync path attaches the target.
    await writeBackDcr(item.id, {
      oauthClientId: reg.clientId,
      oauthClientSecretArn: clientSecretArn,
      oauthProviderArn: providerArn,
      oauthCallbackUrl: callbackUrl,
      oauthRegistrationClientUri: reg.registrationClientUri,
      oauthRegistrationAccessTokenArn: registrationAccessTokenArn,
    });
    console.log(`[sync-oauth-credential-provider] DCR succeeded for McpServer ${item.id} (client_id=${reg.clientId}).`);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    console.error(`[sync-oauth-credential-provider] DCR failed for McpServer ${item.id}:`, err);
    // Leave no half-created provider behind, then surface the error on the row.
    await deleteProvider(name).catch((cleanupErr) => {
      console.warn(`[sync-oauth-credential-provider] Failed to clean up placeholder provider ${name}:`, cleanupErr);
    });
    await recordDcrError(item.id, message).catch((writeErr) => {
      console.warn(`[sync-oauth-credential-provider] Failed to record DCR error on ${item.id}:`, writeErr);
    });
  }
}

async function syncRow(item: McpServerRecord, oldItem: McpServerRecord | undefined): Promise<void> {
  const name = providerName(item.id);

  if (item.outboundAuthType !== 'OAUTH_3LO') {
    // Outbound OAuth was turned off (or never on). Clean up a provider left
    // over from a prior save so it doesn't outlive the config that created it.
    if (oldItem?.outboundAuthType === 'OAUTH_3LO') {
      await deleteProvider(name);
      await clearOauthFields(item.id);
    }
    return;
  }

  const built = buildProviderConfig(item);
  if (!built) return; // not fully configured yet — nothing to sync

  if (item.oauthProviderArn && configUnchanged(oldItem, item)) return; // already in sync

  if (item.oauthProviderArn) {
    const updated = await controlClient.send(new UpdateOauth2CredentialProviderCommand({
      name,
      credentialProviderVendor: built.vendor,
      oauth2ProviderConfigInput: built.config,
    }));
    if (updated.credentialProviderArn) {
      await writeBackProvider(item.id, updated.credentialProviderArn, updated.callbackUrl);
    }
    return;
  }

  // Create-if-absent: a prior invocation of this same row (e.g. a retried
  // stream batch) may have already created the provider but failed before
  // the DynamoDB write-back — look it up by its deterministic name first so
  // a retry doesn't fail on "already exists".
  const existing = await controlClient
    .send(new GetOauth2CredentialProviderCommand({ name }))
    .catch((err) => {
      if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
      throw err;
    });

  if (existing?.credentialProviderArn) {
    await writeBackProvider(item.id, existing.credentialProviderArn, existing.callbackUrl);
    return;
  }

  const created = await controlClient.send(new CreateOauth2CredentialProviderCommand({
    name,
    credentialProviderVendor: built.vendor,
    oauth2ProviderConfigInput: built.config,
  }));
  if (created.credentialProviderArn) {
    await writeBackProvider(item.id, created.credentialProviderArn, created.callbackUrl);
  }
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    const oldItem = unmarshalItem(record.dynamodb?.OldImage);

    if (record.eventName === 'REMOVE') {
      if (oldItem?.id) {
        // Best-effort RFC 7592 DELETE of the dynamic registration, if any — never
        // block row/provider deletion on the external AS being reachable (#449).
        if (oldItem.oauthRegistrationClientUri) {
          try {
            const registrationAccessToken = oldItem.oauthRegistrationAccessTokenArn
              ? await readSecretJsonValue(oldItem.oauthRegistrationAccessTokenArn, REGISTRATION_TOKEN_JSON_KEY)
              : undefined;
            await deleteClientRegistration({
              registrationClientUri: oldItem.oauthRegistrationClientUri,
              registrationAccessToken,
            });
          } catch (err) {
            console.warn(`[sync-oauth-credential-provider] RFC 7592 delete failed for ${oldItem.id} (ignored):`, err);
          }
        }
        if (oldItem.outboundAuthType === 'OAUTH_3LO') {
          await deleteProvider(providerName(oldItem.id));
        }
      }
      continue;
    }

    const item = unmarshalItem(record.dynamodb?.NewImage);
    if (!item?.id) continue;

    // Dynamic Client Registration (#449): auto-run on create when the flag is
    // set and no client_id exists yet. Idempotent — a row that already has
    // oauthClientId is handled by the normal sync path below. DCR writes its
    // results back, re-triggering this stream for the normal reconcile.
    //
    // The `!item.oauthError` guard breaks a failure loop: on a persistent
    // registration failure the catch records oauthError, which is itself a
    // MODIFY that would otherwise re-satisfy the flag/no-client_id condition and
    // hammer the AS /register + AgentCore create/delete forever. A failed
    // attempt therefore parks until the operator clears oauthError (e.g. by
    // re-saving the row after fixing the discovery URL / initial access token),
    // whose MODIFY then re-triggers DCR.
    if (item.oauthDynamicRegistration && !item.oauthClientId && !item.oauthError) {
      await performDynamicRegistration(item);
      continue;
    }

    await syncRow(item, oldItem);
  }
};
