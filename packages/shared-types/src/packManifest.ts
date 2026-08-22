export type PackManifest = {
  /** Unique identifier for the pack (used as folder name) */
  id: string;
  /** Human readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** Agent configuration that maps to the `Agent` table */
  agent: {
    name: string;
    /** Optional slug; if omitted a slug will be derived from the name */
    slug?: string;
    description?: string;
    /** Inline system prompt text – takes precedence over systemPromptFile */
    systemPromptText?: string;
    /** Path to a markdown file (relative to the pack folder) containing the system prompt */
    systemPromptFile?: string;
    modelId?: string;
    /** Whether the agent is enabled (default true) */
    enabled?: boolean;
  };
  /** List of MCP servers the agent can call – maps to the `McpServer` table */
  mcpServers: Array<{
    name: string;
    url: string;
    description?: string;
    serverType?: 'agentcore' | 'mcp';
    headers?: Array<{ key: string; value: string }>;
    authSecretArn?: string;
    oauthClientId?: string;
    gatewayTargetId?: string;
    enabled?: boolean;
  }>;
  /** Optional group‑tool grants – map to `GroupToolGrant` rows */
  groupGrants?: Array<{
    group: string;
    toolName: string;
    effect: 'ALLOW' | 'DENY';
  }>;
};

/** JSON Schema for `pack.json` files. */
export const packManifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Pack Manifest',
  type: 'object',
  required: ['id', 'name', 'agent', 'mcpServers'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    agent: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        slug: { type: 'string' },
        description: { type: 'string' },
        systemPromptText: { type: 'string' },
        systemPromptFile: { type: 'string' },
        modelId: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    mcpServers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' },
          serverType: { type: 'string', enum: ['agentcore', 'mcp'] },
          headers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'value'],
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          authSecretArn: { type: 'string' },
          oauthClientId: { type: 'string' },
          gatewayTargetId: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    groupGrants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['group', 'toolName', 'effect'],
        properties: {
          group: { type: 'string' },
          toolName: { type: 'string' },
          effect: { type: 'string', enum: ['ALLOW', 'DENY'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
