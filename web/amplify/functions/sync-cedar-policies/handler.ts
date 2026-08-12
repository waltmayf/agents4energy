// Syncs GroupToolGrant rows (web/amplify/data/schemas/agentConfig.schema.ts)
// to Cedar policies on the `DefaultCedar` policy engine (#271) attached to
// default-gateway. Triggered by a DynamoDB Stream on the GroupToolGrant table
// (see backend.ts) whenever a grant is created/updated/deleted via the #247
// admin UI — so policy changes take effect within seconds, not at the next
// deploy. See docs/mcp-tool-permissions.md "Cedar policy engine" for why a
// stream-triggered Lambda was chosen over a build-time step.
//
// The stream event itself is only used as a "something changed" signal — this
// always re-reads every GroupToolGrant + McpServer row and does a full
// reconcile (via syncCedarPolicies), rather than translating the individual
// stream record. That avoids ever getting out of sync with the source of
// truth (e.g. after a batch edit, a failed prior invocation, or concurrent
// writes) at the cost of a few extra DynamoDB/AgentCore API calls per change —
// grant edits are an infrequent, admin-only action, so that's the right
// tradeoff.

import {
  BedrockAgentCoreControlClient,
  ListPoliciesCommand,
  CreatePolicyCommand,
  UpdatePolicyCommand,
  DeletePolicyCommand,
  GetGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBClient, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamHandler } from 'aws-lambda';
import {
  generateCedarPolicies,
  type ToolGrantInput,
  type ToolGrantEffect,
  type CedarPolicySpec,
} from '../../../lib/cedar-policy-generation';
import { syncCedarPolicies, type PolicyEngineClient, type ExistingPolicySummary } from '../../../lib/cedar-policy-sync';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const POLICY_ENGINE_ID = process.env.POLICY_ENGINE_ID!;
const GATEWAY_ID = process.env.GATEWAY_ID!;
const GATEWAY_ARN = process.env.GATEWAY_ARN!;
const GROUP_TOOL_GRANT_TABLE_NAME = process.env.GROUP_TOOL_GRANT_TABLE_NAME!;
const MCP_SERVER_TABLE_NAME = process.env.MCP_SERVER_TABLE_NAME!;

const controlClient = new BedrockAgentCoreControlClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

const policyEngineClient: PolicyEngineClient = {
  async listPolicies(policyEngineId): Promise<ExistingPolicySummary[]> {
    const all: ExistingPolicySummary[] = [];
    let nextToken: string | undefined;
    do {
      const res = await controlClient.send(
        new ListPoliciesCommand({ policyEngineId, nextToken, maxResults: 100 }),
      );
      for (const p of res.policies ?? []) {
        if (p.name && p.policyId) all.push({ name: p.name, policyId: p.policyId });
      }
      nextToken = res.nextToken;
    } while (nextToken);
    return all;
  },

  async createPolicy(policyEngineId, policy: CedarPolicySpec): Promise<void> {
    await controlClient.send(
      new CreatePolicyCommand({
        policyEngineId,
        name: policy.name,
        description: policy.description,
        definition: { cedar: { statement: policy.statement } },
        validationMode: policy.validationMode,
        enforcementMode: policy.enforcementMode,
      }),
    );
  },

  async updatePolicy(policyEngineId, policyId, policy: CedarPolicySpec): Promise<void> {
    await controlClient.send(
      new UpdatePolicyCommand({
        policyEngineId,
        policyId,
        description: { optionalValue: policy.description },
        definition: { cedar: { statement: policy.statement } },
        validationMode: policy.validationMode,
        enforcementMode: policy.enforcementMode,
      }),
    );
  },

  async deletePolicy(policyEngineId, policyId): Promise<void> {
    await controlClient.send(new DeletePolicyCommand({ policyEngineId, policyId }));
  },
};

interface GroupToolGrantRow {
  group: string;
  mcpServerId: string;
  toolName: string;
  effect: ToolGrantEffect;
}

interface McpServerRow {
  id: string;
  gatewayTargetId?: string | null;
}

async function scanAll<T>(tableName: string): Promise<T[]> {
  const all: T[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    for (const item of res.Items ?? []) {
      all.push(unmarshall(item) as T);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return all;
}

interface ResolvedTarget {
  targetName: string;
  /** Concrete tool names on this target, for enumerating "*" wildcard grants (see cedar-policy-generation.ts). Undefined if the target's tool schema isn't inline (e.g. an S3-hosted schema). */
  toolNames?: string[];
}

/** GetGatewayTarget's `name` is the Cedar action-naming "<targetName>" segment (see cedar-policy-generation.ts). */
async function resolveTarget(gatewayTargetId: string): Promise<ResolvedTarget | null> {
  try {
    const res = await controlClient.send(
      new GetGatewayTargetCommand({ gatewayIdentifier: GATEWAY_ID, targetId: gatewayTargetId }),
    );
    if (!res.name) return null;
    const inlinePayload = res.targetConfiguration?.mcp?.lambda?.toolSchema?.inlinePayload;
    const toolNames = inlinePayload?.map((tool) => tool.name).filter((name): name is string => !!name);
    return { targetName: res.name, toolNames };
  } catch {
    // The target may have been deleted out-of-band, or belong to a stale
    // gatewayTargetId left over from a prior gateway. Skip grants for it
    // rather than failing the whole sync — the corresponding Cedar policy is
    // simply not generated this round (a subsequent sync will pick it up
    // once the McpServer's gatewayTargetId is fixed).
    return null;
  }
}

export const handler: DynamoDBStreamHandler = async () => {
  const [grants, servers] = await Promise.all([
    scanAll<GroupToolGrantRow>(GROUP_TOOL_GRANT_TABLE_NAME),
    scanAll<McpServerRow>(MCP_SERVER_TABLE_NAME),
  ]);

  const targetByServerId = new Map<string, ResolvedTarget>();
  const registeredServers = servers.filter((s): s is McpServerRow & { gatewayTargetId: string } => !!s.gatewayTargetId);
  const resolved = await Promise.all(
    registeredServers.map(async (s) => ({ id: s.id, target: await resolveTarget(s.gatewayTargetId) })),
  );
  for (const { id, target } of resolved) {
    if (target) targetByServerId.set(id, target);
  }

  // Grants on a server with no resolvable gateway target (never registered,
  // or registration is stale) can't be translated into a Cedar action name —
  // skip them; they simply produce no policy until the server is (re)registered.
  const translatable: ToolGrantInput[] = grants.flatMap((grant) => {
    const target = targetByServerId.get(grant.mcpServerId);
    if (!target) return [];
    return [{
      group: grant.group,
      targetName: target.targetName,
      toolName: grant.toolName,
      effect: grant.effect,
      targetToolNames: target.toolNames,
    }];
  });

  const desired = generateCedarPolicies(translatable, GATEWAY_ARN);
  const result = await syncCedarPolicies(policyEngineClient, POLICY_ENGINE_ID, desired);
  const droppedWildcards = translatable.length - desired.length;

  console.log(
    `Cedar policy sync: ${result.created.length} created, ${result.updated.length} updated, ${result.deleted.length} deleted ` +
      `(${grants.length} grants, ${grants.length - translatable.length} skipped for unresolved gateway targets, ` +
      `${droppedWildcards} "*" grants dropped for unresolved tool names).`,
  );
};
