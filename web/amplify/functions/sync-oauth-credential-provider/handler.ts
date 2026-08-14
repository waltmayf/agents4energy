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

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const MCP_SERVER_TABLE_NAME = process.env.MCP_SERVER_TABLE_NAME!;

const controlClient = new BedrockAgentCoreControlClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

// The JSON key under which the client secret value must be stored in the
// Secrets Manager secret referenced by McpServer.oauthClientSecretArn — i.e.
// the secret value is `{ "clientSecret": "<value>" }`. Whatever creates that
// secret (epic #412 slice 7, the MCP Servers UI) must follow this convention.
const CLIENT_SECRET_JSON_KEY = 'clientSecret';

interface McpServerRecord {
  id: string;
  outboundAuthType?: 'NONE' | 'OAUTH_3LO';
  oauthVendor?: 'GOOGLE' | 'CUSTOM';
  oauthClientId?: string;
  oauthClientSecretArn?: string;
  oauthDiscoveryUrl?: string;
  oauthProviderArn?: string;
  oauthCallbackUrl?: string;
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
      if (oldItem?.outboundAuthType === 'OAUTH_3LO' && oldItem.id) {
        await deleteProvider(providerName(oldItem.id));
      }
      continue;
    }

    const item = unmarshalItem(record.dynamodb?.NewImage);
    if (!item?.id) continue;

    await syncRow(item, oldItem);
  }
};
