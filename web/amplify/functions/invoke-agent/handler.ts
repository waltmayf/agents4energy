import { randomUUID } from 'crypto';
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

function buildTools(mcpServers: McpServerRecord[]): HarnessTool[] {
  return mcpServers.map((s) => ({
    type: 'remote_mcp',
    name: s.name.replace(/[^a-zA-Z0-9_-]/g, '_'),
    config: {
      remoteMcp: {
        url: s.url,
        headers: s.headers?.length
          ? headersFromArray(s.headers.filter((h): h is { key: string | null; value: string | null } => h !== null))
          : undefined,
      },
    },
  }));
}

async function invokeHarness(opts: {
  sessionId: string;
  prompt: string;
  systemPromptText: string | null;
  modelId: string | null;
  mcpServers: McpServerRecord[];
}): Promise<string> {
  const { sessionId, prompt, systemPromptText, modelId, mcpServers } = opts;

  const tools = buildTools(mcpServers);

  const response = await agentCore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    systemPrompt: systemPromptText ? [{ text: systemPromptText }] : undefined,
    model: modelId ? { bedrockModelConfig: { modelId } } : undefined,
    tools: tools.length ? tools : undefined,
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

  const agentConfig = await fetchAgentConfig(agentSlug);
  if (!agentConfig) {
    return {
      response: `No enabled agent found with slug "${agentSlug}".`,
      sessionId,
    };
  }

  const response = await invokeHarness({
    sessionId,
    prompt,
    systemPromptText: agentConfig.systemPromptText,
    modelId: agentConfig.modelId,
    mcpServers: agentConfig.mcpServers,
  });

  return { response, sessionId };
};
