/**
 * Spike #514 — Agent + McpServer slice mirroring
 * web/amplify/data/schemas/agentConfig.schema.ts, wired via `fromExisting`
 * at the deployed Cognito user pool + DynamoDB tables (criterion 3), exposed
 * as typed RPC (criterion 2) instead of GraphQL/codegen.
 */
import { ApiNamespace, Scope, DistributedTable } from '@aws-blocks/blocks';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import { z } from 'zod';

const scope = new Scope('blocks-poc');

// ─── Auth — fromExisting against the real deployed user pool (criterion 3) ──
const DEPLOYED_USER_POOL_ID = 'us-east-1_lX3bmmkcZ';
const DEPLOYED_USER_POOL_CLIENT_ID = '7uo4jck2flu2pnn3trmuntksti';

const auth = new AuthCognito(scope, 'auth', {
  userPool: AuthCognito.fromExisting(DEPLOYED_USER_POOL_ID, DEPLOYED_USER_POOL_CLIENT_ID),
});
export const authApi = auth.createApi();

// ─── Data — fromExisting against the real deployed DynamoDB tables ─────────
const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  systemPromptText: z.string().optional(),
  modelId: z.string().optional(),
  enabled: z.boolean().default(true),
});

const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  description: z.string().optional(),
  serverType: z.string().optional(),
  gatewayTargetId: z.string().optional(),
});

const agents = new DistributedTable(scope, 'agents', {
  schema: agentSchema,
  key: { partitionKey: 'id' },
  table: DistributedTable.fromExisting('Agent-vaaaqs3d4ffj5dsmfmtnvhugca-NONE'),
});

const mcpServers = new DistributedTable(scope, 'mcpServers', {
  schema: mcpServerSchema,
  key: { partitionKey: 'id' },
  table: DistributedTable.fromExisting('McpServer-vaaaqs3d4ffj5dsmfmtnvhugca-NONE'),
});

// ─── API — the exact ops list-mcp-tools.ts / use-agents.ts / mcp-server-safe-list.ts call today ──
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listAgents() {
    await auth.requireAuth(context);
    return await Array.fromAsync(agents.scan());
  },

  async getAgent(id: string) {
    await auth.requireAuth(context);
    return await agents.get({ id });
  },

  async createAgent(input: { name: string; slug: string; description?: string; systemPromptText?: string; modelId?: string }) {
    await auth.requireAuth(context);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const agent = { id, enabled: true, ...input };
    await agents.put(agent);
    return agent;
  },

  async listMcpServers() {
    await auth.requireAuth(context);
    return await Array.fromAsync(mcpServers.scan());
  },
}));
