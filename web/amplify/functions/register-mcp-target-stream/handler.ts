import { DynamoDBStreamHandler } from 'aws-lambda';
import { AttributeValue, DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  UpdateGatewayTargetCommand,
  CredentialProviderType,
  OAuthGrantType,
  type CredentialProviderConfiguration,
  type McpToolSchemaConfiguration,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const GATEWAY_ID = process.env.GATEWAY_ID!;

const controlClient = new BedrockAgentCoreControlClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

// How long to wait for an unauthenticated tools/list probe (see probeToolSchema
// below) before giving up and falling back to an empty schema. Kept well under
// the Lambda timeout so one slow/unreachable server can't stall the batch.
const PROBE_TIMEOUT_MS = 6000;
const MCP_PROTOCOL_VERSION = '2025-03-26';

interface McpServerRecord {
  id: string;
  name?: string;
  url?: string;
  description?: string;
  gatewayTargetId?: string;
  outboundAuthType?: 'NONE' | 'OAUTH_3LO';
  oauthProviderArn?: string;
  oauthReturnUrl?: string;
  oauthCallbackUrl?: string;
  oauthScopes?: string[];
}

// Helper to generate safe gateway target name (same logic as register-mcp-target handler).
function safeName(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'mcp-target';
}

// Best-effort, unauthenticated MCP tools/list probe against the downstream
// server. AUTHORIZATION_CODE-grant credential providers only vault a token
// per end user, so this Lambda has no token to call the server with — but
// tool *metadata* (unlike tool *invocation*) is commonly served without auth,
// so this often still succeeds. Returns undefined on any failure (network,
// non-2xx, auth-required, malformed response) so the caller can fall back to
// an empty static schema — see buildMcpToolSchema.
async function probeToolSchema(url: string): Promise<unknown[] | undefined> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Version': MCP_PROTOCOL_VERSION,
  };

  const post = async (body: unknown): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`MCP server responded ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
        }
        throw new Error('MCP SSE response contained no parseable data lines');
      }
      return res.json();
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agentcore-gateway-target-registration', version: '1.0' },
      },
    });
    const toolsResp = (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as {
      result?: { tools?: unknown[] };
      error?: { message?: string };
    };
    if (toolsResp.error) throw new Error(toolsResp.error.message ?? 'tools/list returned an error');
    return toolsResp.result?.tools ?? [];
  } catch (err) {
    console.warn(`[register-mcp-target-stream] Unauthenticated tools/list probe failed for ${url}:`, err);
    return undefined;
  }
}

// Builds the static mcpToolSchema AgentCore requires for an AUTHORIZATION_CODE
// gateway target. Providing one upfront — even an empty one — lets
// CreateGatewayTarget/UpdateGatewayTarget complete synchronously instead of
// entering CREATE_PENDING_AUTH, which would otherwise require an interactive
// admin OAuth login that a stream-triggered Lambda cannot perform. The
// tradeoff: this disables AgentCore's dynamic tool discovery/sync for 3LO
// targets, so the tool list won't automatically track the downstream server
// after this initial probe (see design note on issue #415).
async function buildMcpToolSchema(url: string): Promise<McpToolSchemaConfiguration> {
  const tools = await probeToolSchema(url);
  return { inlinePayload: JSON.stringify(tools ?? []) };
}

function buildCredentialProviderConfigurations(
  item: McpServerRecord,
): CredentialProviderConfiguration[] | undefined {
  if (item.outboundAuthType !== 'OAUTH_3LO' || !item.oauthProviderArn) return undefined;
  return [
    {
      credentialProviderType: CredentialProviderType.OAUTH,
      credentialProvider: {
        oauthCredentialProvider: {
          providerArn: item.oauthProviderArn,
          grantType: OAuthGrantType.AUTHORIZATION_CODE,
          // oauthReturnUrl is the McpServer row's own field for this (see
          // schema comment); oauthCallbackUrl is AgentCore's callback
          // registered with the *external* IdP, which we only fall back to
          // if the operator hasn't set an explicit return URL.
          defaultReturnUrl: item.oauthReturnUrl || item.oauthCallbackUrl,
          scopes: item.oauthScopes ?? [],
        },
      },
    },
  ];
}

// Which fields feed buildCredentialProviderConfigurations — a MODIFY that
// doesn't touch any of these (e.g. renaming the server) shouldn't trigger an
// UpdateGatewayTarget call against an already-registered target.
function outboundAuthUnchanged(oldItem: McpServerRecord | undefined, item: McpServerRecord): boolean {
  return (
    !!oldItem &&
    oldItem.outboundAuthType === item.outboundAuthType &&
    oldItem.oauthProviderArn === item.oauthProviderArn &&
    oldItem.oauthReturnUrl === item.oauthReturnUrl &&
    oldItem.oauthCallbackUrl === item.oauthCallbackUrl &&
    JSON.stringify(oldItem.oauthScopes ?? []) === JSON.stringify(item.oauthScopes ?? [])
  );
}

export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;
    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;
    const item = unmarshall(newImage as unknown as Record<string, AttributeValue>) as McpServerRecord;
    const { id, name, url, description, gatewayTargetId, outboundAuthType, oauthProviderArn } = item;

    const oldImage = record.dynamodb?.OldImage;
    const oldItem = oldImage
      ? (unmarshall(oldImage as unknown as Record<string, AttributeValue>) as McpServerRecord)
      : undefined;

    // Self-heal a poisoned `name` (#387). `name` is `a.string().required()`,
    // but Amplify's generated `UpdateMcpServerInput` makes every field
    // nullable regardless of the model's `.required()` (partial-update
    // semantics), and the default DynamoDB resolver REMOVEs any attribute an
    // update explicitly sets to null — so an `updateMcpServer` mutation with
    // `name: null` silently drops the attribute with no validation error.
    // That poisons every `listMcpServers` query for everyone via AppSync's
    // non-null propagation (the generated connection type is
    // `items: [McpServer!]!`). Only MODIFY can produce this — createMcpServer
    // requires `name` at the GraphQL layer — so restore it from OldImage.
    if (!name && record.eventName === 'MODIFY') {
      const oldName = oldItem?.name;
      if (oldName) {
        await ddb.send(
          new UpdateItemCommand({
            TableName: process.env.MCP_SERVER_TABLE_NAME!,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #n = :n',
            ExpressionAttributeNames: { '#n': 'name' },
            ExpressionAttributeValues: { ':n': { S: oldName } },
          }),
        );
        console.warn(`[register-mcp-target-stream] Restored null name on McpServer ${id} to "${oldName}" (#387).`);
      } else {
        console.warn(`[register-mcp-target-stream] McpServer ${id} has a null name with no prior value to restore.`);
      }
      continue; // our own UpdateItem re-triggers this handler; skip registration this pass
    }

    // OAUTH_3LO configured but the credential provider isn't ready yet (the
    // sync-oauth-credential-provider stream handler writes oauthProviderArn
    // back onto this same row once it's created) — wait for that MODIFY
    // rather than registering a NO_AUTH target we'd immediately need to fix up.
    if (outboundAuthType === 'OAUTH_3LO' && !oauthProviderArn) continue;

    const credentialProviderConfigurations = buildCredentialProviderConfigurations(item);

    if (gatewayTargetId) {
      // Already registered. Only re-sync when the outbound-auth wiring
      // itself changed — this handler doesn't own the target's name/url/etc.
      if (record.eventName !== 'MODIFY' || outboundAuthUnchanged(oldItem, item)) continue;

      const mcpToolSchema = credentialProviderConfigurations ? await buildMcpToolSchema(url!) : undefined;
      await controlClient.send(
        new UpdateGatewayTargetCommand({
          gatewayIdentifier: GATEWAY_ID,
          targetId: gatewayTargetId,
          name: safeName(name!),
          description: description ?? `MCP server: ${name}`,
          targetConfiguration: {
            mcp: { mcpServer: { endpoint: url, ...(mcpToolSchema ? { mcpToolSchema } : {}) } },
          },
          credentialProviderConfigurations,
        }),
      );
      continue;
    }

    // Register gateway target
    const mcpToolSchema = credentialProviderConfigurations ? await buildMcpToolSchema(url!) : undefined;
    const result = await controlClient.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: GATEWAY_ID,
        name: safeName(name!),
        description: description ?? `MCP server: ${name}`,
        targetConfiguration: {
          mcp: { mcpServer: { endpoint: url, ...(mcpToolSchema ? { mcpToolSchema } : {}) } },
        },
        credentialProviderConfigurations,
      }),
    );
    const targetId = result.targetId;
    if (!targetId) continue;
    // Update DynamoDB item with the targetId
    await ddb.send(
      new UpdateItemCommand({
        TableName: process.env.MCP_SERVER_TABLE_NAME!,
        Key: { id: { S: id } },
        UpdateExpression: 'SET gatewayTargetId = :gt',
        ExpressionAttributeValues: { ':gt': { S: targetId } },
      }),
    );
  }
};
