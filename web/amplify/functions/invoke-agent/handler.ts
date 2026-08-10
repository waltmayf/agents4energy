import { randomUUID } from 'crypto';
import type { AppSyncIdentityCognito } from 'aws-lambda';
import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  BatchGetItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessTool,
} from '@aws-sdk/client-bedrock-agentcore';
import { encodeRuntimeUserId, type CallerIdentity } from '../../../lib/caller-identity';

const HARNESS_ARN = process.env.HARNESS_ARN!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const AGENT_TABLE = process.env.AGENT_TABLE!;
const MCP_SERVER_TABLE = process.env.MCP_SERVER_TABLE!;
const AGENT_MCP_SERVER_TABLE = process.env.AGENT_MCP_SERVER_TABLE!;

const ddb = new DynamoDBClient({ region: REGION });

// The harness authorizes with AWS_IAM: the SDK client signs InvokeHarness with
// this Lambda's execution-role credentials (SigV4). No Cognito service account
// / SSM password needed, and the SDK owns the event-stream decode + timeouts.
const agentCore = new BedrockAgentCoreClient({ region: REGION });

interface InvokeAgentArgs {
  agentSlug: string;
  prompt: string;
  sessionId?: string;
}

interface InvokeAgentEvent {
  arguments: InvokeAgentArgs;
  // AppSync populates this from the verified Cognito JWT when the mutation is
  // called with userPool auth (allow.authenticated()); IAM-signed callers
  // (allow.guest(), e.g. GitHub Actions) get an IAM identity shape instead, or
  // none at all in a unit-test invocation.
  identity?: AppSyncIdentityCognito | { sub?: never; groups?: never } | null;
  // AppSync forwards the client's original HTTP headers to a direct Lambda
  // resolver — for a userPool-authed call this includes the raw Cognito JWT
  // the client authenticated with (Authorization: <idToken>, no Bearer
  // prefix). Absent for allow.guest() (IAM-signed) callers, which never hold
  // a Cognito JWT at all.
  request?: { headers?: Record<string, string | undefined> };
}

// AppSync populates event.identity from the verified Cognito JWT when this
// mutation is called with userPool auth — so by the time we read sub/groups
// here they're already a verified claim, not caller-supplied input. Encoded
// into InvokeHarnessCommand's runtimeUserId per caller-identity.ts's comment.
function callerIdentityFromEvent(event: InvokeAgentEvent): CallerIdentity {
  const identity = event.identity;
  const sub = identity && 'sub' in identity ? identity.sub ?? null : null;
  const groups = identity && 'groups' in identity ? identity.groups ?? [] : [];
  return { sub, groups: groups ?? [] };
}

// Only present for userPool-authed callers (see InvokeAgentEvent.request comment) —
// allow.guest() (IAM-signed) callers have no Cognito JWT to forward to the gateway.
function callerIdTokenFromEvent(event: InvokeAgentEvent): string | null {
  return event.request?.headers?.authorization ?? null;
}

interface InvokeAgentResult {
  response: string;
  sessionId: string;
}

interface McpServerRecord {
  name: string;
  url: string;
  enabled?: boolean;
  headers?: Array<{ key: string | null; value: string | null } | null>;
  gatewayTargetId?: string;
}

function headersFromArray(
  headers: Array<{ key: string | null; value: string | null }> | null | undefined,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const h of headers) {
    if (h?.key && h?.value) result[h.key] = h.value;
  }
  return result;
}

async function fetchAgentConfig(agentSlug: string) {
  const agentScan = await ddb.send(new ScanCommand({
    TableName: AGENT_TABLE,
    FilterExpression: '#slug = :slug AND #enabled = :enabled',
    ExpressionAttributeNames: { '#slug': 'slug', '#enabled': 'enabled' },
    ExpressionAttributeValues: { ':slug': { S: agentSlug }, ':enabled': { BOOL: true } },
  }));

  const agent = agentScan.Items?.[0] ? unmarshall(agentScan.Items[0]) : null;
  if (!agent) return null;

  const joinQuery = await ddb.send(new QueryCommand({
    TableName: AGENT_MCP_SERVER_TABLE,
    IndexName: 'gsi-Agent.mcpServers',
    KeyConditionExpression: 'agentId = :agentId',
    ExpressionAttributeValues: { ':agentId': { S: agent.id as string } },
  }));

  const mcpServerIds = (joinQuery.Items ?? [])
    .map((item: Record<string, AttributeValue>) => (unmarshall(item).mcpServerId as string))
    .filter(Boolean);

  let mcpServers: McpServerRecord[] = [];
  if (mcpServerIds.length > 0) {
    const keys = mcpServerIds.map((id: string) => ({ id: { S: id } }));
    const batchRes = await ddb.send(new BatchGetItemCommand({
      RequestItems: { [MCP_SERVER_TABLE]: { Keys: keys } },
    }));
    mcpServers = (batchRes.Responses?.[MCP_SERVER_TABLE] ?? [])
      .map((item: Record<string, AttributeValue>) => unmarshall(item) as McpServerRecord)
      .filter((s) => s.enabled !== false);
  }

  return {
    systemPromptText: (agent.systemPromptText as string) ?? null,
    modelId: (agent.modelId as string) ?? null,
    mcpServers,
  };
}

// `callerIdToken` is the caller's raw Cognito JWT (see callerIdTokenFromEvent),
// present only for userPool-authed callers. Attached as `Authorization: Bearer`
// on any server routed through the gateway, since default-gateway's CUSTOM_JWT
// authorizer requires a real Cognito JWT (not the {sub,groups} runtimeUserId
// blob) and Cedar reads `cognito:groups` off that same JWT as a principal tag.
// A guest (IAM-signed) caller has no JWT, so gateway-routed servers silently
// get no Authorization header for them — same as an anonymous gateway call.
function buildTools(mcpServers: McpServerRecord[], callerIdToken: string | null): HarnessTool[] {
  return mcpServers.map((s) => {
    const routeThroughGateway = Boolean(s.gatewayTargetId && process.env.AGENTCORE_GATEWAY_ENDPOINT);
    return {
      type: 'remote_mcp',
      name: s.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
      config: {
        remoteMcp: {
          // Route through the AgentCore gateway when this server is registered as
          // a gateway target (Cedar 3c, #279); fall back to the direct URL if the
          // gateway endpoint isn't configured so a stray gatewayTargetId can never
          // produce an empty url.
          url: routeThroughGateway ? process.env.AGENTCORE_GATEWAY_ENDPOINT : s.url,
          headers: routeThroughGateway
            ? (callerIdToken ? { Authorization: `Bearer ${callerIdToken}` } : undefined)
            : (s.headers?.length
              ? headersFromArray(s.headers.filter((h): h is { key: string | null; value: string | null } => h !== null))
              : undefined),
        },
      },
    };
  });
}

async function invokeHarness(opts: {
  sessionId: string;
  prompt: string;
  systemPromptText: string | null;
  modelId: string | null;
  mcpServers: McpServerRecord[];
  callerIdentity: CallerIdentity;
  callerIdToken: string | null;
}): Promise<string> {
  const { sessionId, prompt, systemPromptText, modelId, mcpServers, callerIdentity, callerIdToken } = opts;

  const tools = buildTools(mcpServers, callerIdToken);

  const response = await agentCore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    systemPrompt: systemPromptText ? [{ text: systemPromptText }] : undefined,
    model: modelId ? { bedrockModelConfig: { modelId } } : undefined,
    tools: tools.length ? tools : undefined,
    runtimeUserId: encodeRuntimeUserId(callerIdentity),
  }));

  const chunks: string[] = [];

  for await (const event of response.stream ?? []) {
    if (event.validationException || event.internalServerException || event.runtimeClientError) {
      const ex = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
      throw new Error(`Harness stream exception: ${ex?.message ?? JSON.stringify(ex)}`);
    }
    const text = event.contentBlockDelta?.delta?.text;
    if (text) chunks.push(text);
  }

  return chunks.join('');
}

export const handler = async (event: InvokeAgentEvent): Promise<InvokeAgentResult> => {
  const { agentSlug, prompt, sessionId: inputSessionId } = event.arguments;
  const sessionId = inputSessionId ?? randomUUID();
  const callerIdentity = callerIdentityFromEvent(event);
  const callerIdToken = callerIdTokenFromEvent(event);

  const agentConfig = await fetchAgentConfig(agentSlug);
  if (!agentConfig) {
    return {
      response: `No enabled agent found with slug "${agentSlug}".`,
      sessionId,
    };
  }

  const response = await invokeHarness({
    callerIdentity,
    callerIdToken,
    sessionId,
    prompt,
    systemPromptText: agentConfig.systemPromptText,
    modelId: agentConfig.modelId,
    mcpServers: agentConfig.mcpServers,
  });

  return { response, sessionId };
};
