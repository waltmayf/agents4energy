import { a } from '@aws-amplify/backend';
import { registerMcpTarget } from '../../functions/register-mcp-target/resource';
import { listMcpTools } from '../../functions/list-mcp-tools/resource';
import { invokeAgent } from '../../functions/invoke-agent/resource';
import { completeResourceTokenAuth } from '../../functions/complete-resource-token-auth/resource';

/**
 * Agent Configuration Schema
 *
 * Agent         — a configurable logical agent identity (system prompt, model, connections)
 * McpServer     — any MCP-compatible endpoint (AgentCore gateway, plain MCP server, etc.)
 * AgentMcpServer — M:N join: which MCP servers are assigned to which agents
 * AgentSubAgent — M:N self-join: which agents a given agent can call as sub-agents
 */
export const agentConfigSchema = a.schema({

  McpServerHeaderEntry: a.customType({
    key: a.string(),
    value: a.string(),
  }),

  // Outbound auth mode for a gateway target's downstream call to the MCP server.
  // NONE: current default (NO_AUTH / static headers). OAUTH_3LO: AgentCore Identity
  // 3-legged OAuth credential provider — each user consents in-browser and the
  // gateway injects that user's vaulted token outbound (see epic #412).
  McpServerOutboundAuthType: a.enum(['NONE', 'OAUTH_3LO']),

  // Which OAuth2 credential-provider vendor backs OAUTH_3LO. GOOGLE uses AgentCore's
  // GoogleOauth2 provider type (fixed authorization/token endpoints); CUSTOM uses
  // CustomOauth2 and requires oauthDiscoveryUrl.
  McpServerOauthVendor: a.enum(['GOOGLE', 'CUSTOM']),

  Agent: a.model({
    name: a.string().required(),
    // URL-safe routing slug, e.g. "ops-agent". Callers pass this as agentId.
    slug: a.string().required(),
    description: a.string(),
    // Inline system prompt text. Takes precedence over systemPromptS3Key when both are set.
    systemPromptText: a.string(),
    // S3 key for the system prompt file, e.g. "agents/ops-agent/system-prompt.md"
    // When set, overrides the DynamoDB Settings.system_prompt fallback.
    systemPromptS3Key: a.string(),
    // Bedrock model override. Falls back to DEFAULT_MODEL_ID env var when absent.
    modelId: a.string(),
    enabled: a.boolean().required().default(true),
    mcpServers: a.hasMany('AgentMcpServer', 'agentId'),
    // Agents that this agent can call as sub-agents (caller side)
    subAgents: a.hasMany('AgentSubAgent', 'agentId'),
    // Agents that can call this agent as a sub-agent (callee side)
    calledByAgents: a.hasMany('AgentSubAgent', 'subAgentId'),
  }).authorization((allow) => [
    allow.authenticated().to(['read', 'create', 'update', 'delete']),
    allow.owner(),
    // Admits IAM-signed requests (e.g. S3ToolsMcpServerSeed's SigV4-signed
    // custom-resource Lambda, which has no Cognito sub) in identityPool mode —
    // same pattern as ChatSession/ActiveRun. Needed so the deploy-time seed
    // can create/read this demo row.
    allow.guest(),
  ]),

  // Unified MCP server record — covers AgentCore gateways and plain MCP endpoints.
  // serverType: "agentcore" | "mcp" (defaults to "mcp" if absent).
  // AgentCore servers use workload-identity Bearer auth; plain MCP servers may use
  // custom headers or no auth. authSecretArn / registryId / registryRecordId are
  // AgentCore-specific and ignored for plain MCP servers.
  McpServer: a.model({
    name: a.string().required(),
    url: a.string().required(),
    description: a.string(),
    serverType: a.string(),
    // Secret-bearing: `headers` carries bearer tokens/API keys and
    // `authSecretArn` points at a Secrets Manager secret. Field-level auth
    // strips these from guest (unauthenticated identity-pool) reads so the
    // model-level allow.guest() below — required so the SigV4 deploy-time seed
    // can list/create the demo row — cannot leak another user's credentials.
    // (The seed never selects these fields.) authenticated()+owner() here
    // matches the pre-guest posture; it does not widen access.
    headers: a.ref('McpServerHeaderEntry').array().authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),
    // AgentCore-specific fields
    authSecretArn: a.string().authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),
    registryId: a.string(),
    registryRecordId: a.string(),
    signRequestsWithAwsCreds: a.boolean().default(false),
    // ID of the registered gateway target for this MCP server (set after CreateGatewayTarget).
    // Null until the user registers the server with the gateway.
    gatewayTargetId: a.string(),
    // OAuth2 client ID. Dual purpose:
    // - PKCE (legacy direct-MCP flow): the UI shows an "Authenticate" button that
    //   runs the PKCE flow and saves the resulting token in McpServerCredential
    //   (owner-scoped, per-user).
    // - OAUTH_3LO (gateway-target flow, epic #412): the client ID registered with
    //   the AgentCore Identity OAuth2 credential provider (paired with
    //   oauthClientSecretArn).
    oauthClientId: a.string(),

    // --- Outbound auth (3LO), epic #412. See McpServerOutboundAuthType/McpServerOauthVendor above. ---
    // Amplify enum refs don't support .default(); absent/null is treated as NONE by all readers.
    outboundAuthType: a.ref('McpServerOutboundAuthType'),
    oauthVendor: a.ref('McpServerOauthVendor'),
    // Discovery URL of the external OIDC provider. Required for oauthVendor CUSTOM;
    // unused for GOOGLE (AgentCore's GoogleOauth2 provider has fixed endpoints).
    oauthDiscoveryUrl: a.string(),
    // Secrets Manager ARN holding the OAuth2 client secret for the credential
    // provider. The secret value itself is never stored in this row — field-level
    // auth below strips it from guest (unauthenticated identity-pool) reads, same
    // posture as authSecretArn/headers above.
    oauthClientSecretArn: a.string().authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),
    // Scopes requested from the external IdP during the 3LO consent flow.
    oauthScopes: a.string().array(),
    // App return URL AgentCore redirects to after consent completes
    // (`defaultReturnUrl` on the credential provider's oauthCredentialProvider config).
    oauthReturnUrl: a.string(),
    // ARN of the AgentCore Identity OAuth2 credential provider. Written back by
    // slice 1 (#413) after CreateOauth2CredentialProvider.
    oauthProviderArn: a.string(),
    // Callback URL AgentCore assigns to the credential provider
    // (`https://bedrock-agentcore.<region>.amazonaws.com/identities/oauth2/callback/<uuid>`).
    // Written back by slice 1 (#413); must be added to the external IdP's redirect URIs.
    oauthCallbackUrl: a.string(),

    // --- Outbound Dynamic Client Registration (RFC 7591), issue #449. ---
    // When true and oauthClientId is still empty, the sync-oauth-credential-provider
    // stream handler self-registers this app as an OAuth client against the AS's
    // DCR endpoint (provider-first ordering: create a placeholder CustomOauth2
    // provider to obtain AgentCore's callbackUrl, POST /register with that
    // redirect_uri, store the issued client_secret, then Update the provider with
    // the real client_id). Idempotent: a row that already has oauthClientId is
    // skipped. Absent/null is treated as false.
    oauthDynamicRegistration: a.boolean(),
    // Explicit RFC 7591 registration endpoint. When unset, it is resolved from
    // the OIDC discovery document at oauthDiscoveryUrl (`registration_endpoint`).
    oauthRegistrationEndpoint: a.string(),
    // Optional `client_name` sent in the registration request (falls back to the
    // McpServer row's own name).
    oauthClientName: a.string(),
    // Optional RFC 7591 `software_statement` (a signed JWT) sent with the
    // registration request. Not itself a secret (it's a signed assertion).
    oauthSoftwareStatement: a.string(),
    // RFC 7592 bookkeeping — the AS returns a per-client management URI and a
    // registration access token so the registration can later be read, updated,
    // or deleted. oauthRegistrationClientUri drives the best-effort DELETE on row
    // removal; the access token lives in Secrets Manager (see the *Arn field).
    oauthRegistrationClientUri: a.string(),
    // Visible error state: set to the DCR failure reason when self-registration
    // fails, so the operator sees why rather than a silently half-created provider.
    oauthError: a.string(),
    // Secrets Manager ARN of an optional RFC 7591 `initial_access_token` (Bearer)
    // required by some authorization servers to authorize registration. The secret
    // value itself never lives in this row — same secret-ARN posture as
    // oauthClientSecretArn (field-level auth strips it from guest reads).
    oauthInitialAccessTokenArn: a.string().authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),
    // Secrets Manager ARN holding the RFC 7592 registration access token issued at
    // registration, used to update/delete the dynamic registration later. Written
    // back by the DCR handler; same secret-ARN posture as oauthClientSecretArn.
    oauthRegistrationAccessTokenArn: a.string().authorization((allow) => [
      allow.authenticated().to(['read', 'create', 'update', 'delete']),
      allow.owner(),
    ]),

    enabled: a.boolean().required().default(true),
    agents: a.hasMany('AgentMcpServer', 'mcpServerId'),
    credentials: a.hasMany('McpServerCredential', 'mcpServerId'),
    groupGrants: a.hasMany('GroupToolGrant', 'mcpServerId'),
  }).authorization((allow) => [
    allow.authenticated().to(['read', 'create', 'update', 'delete']),
    allow.owner(),
    // See Agent's allow.guest() comment above — same seed needs this too.
    allow.guest(),
  ]),

  // Per-user OAuth2 token for an MCP server that requires PKCE auth.
  // owner-only: DynamoDB owner field ensures each user sees only their own tokens.
  // invokeAgent Lambda read access is granted via the wrapper in resource.ts.
  McpServerCredential: a.model({
    mcpServerId: a.id().required(),
    mcpServer: a.belongsTo('McpServer', 'mcpServerId'),
    accessToken: a.string().required(),
    tokenType: a.string(),
    // ISO-8601 timestamp so the UI can warn when the token is approaching expiry.
    expiresAt: a.string(),
    // Refresh token for silent renewal (if the authorization server issued one).
    refreshToken: a.string(),
    // Space-delimited scopes actually granted, as returned by the token endpoint.
    scope: a.string(),
  }).authorization((allow) => [
    allow.owner(),
  ]),

  // M:N join between Agent and McpServer
  AgentMcpServer: a.model({
    agentId: a.id().required(),
    mcpServerId: a.id().required(),
    agent: a.belongsTo('Agent', 'agentId'),
    mcpServer: a.belongsTo('McpServer', 'mcpServerId'),
    // Deprecated (#247): unused by any read path. Group -> tool authorization is
    // now expressed by GroupToolGrant below, which is per-(group, server, tool)
    // rather than per-(agent, server) — a group's grants apply to every agent
    // that exposes that server, not just one. Left in place (nullable, unread)
    // rather than dropped, to avoid a destructive schema migration; new code
    // should not read or write it.
    enabledTools: a.string().array(),
  }).authorization((allow) => [
    allow.authenticated().to(['read', 'create', 'update', 'delete']),
    allow.owner(),
    // See Agent's allow.guest() comment above — same seed needs this too.
    allow.guest(),
  ]),

  // Effect of a GroupToolGrant: whether the group may or may not call the tool.
  ToolGrantEffect: a.enum(['ALLOW', 'DENY']),

  // Maps a Cognito group to the MCP tools it may call, per MCP server. This is
  // the human-editable source of truth that Cedar policies (#248) will be
  // generated from — it is NOT itself an enforcement mechanism. Client-side
  // filtering in use-agents.ts is UX-only, not a security boundary.
  GroupToolGrant: a.model({
    // Cognito group name, e.g. "admin" | "reservoir-eng" | "drilling".
    group: a.string().required(),
    mcpServerId: a.id().required(),
    mcpServer: a.belongsTo('McpServer', 'mcpServerId'),
    // Tool name as returned by listMcpTools, or "*" to match every tool on
    // this server.
    toolName: a.string().required(),
    effect: a.ref('ToolGrantEffect').required(),
  }).authorization((allow) => [
    allow.group('admin').to(['read', 'create', 'update', 'delete']),
    allow.authenticated().to(['read']),
  ]),

  // A single MCP tool descriptor returned by listMcpTools.
  McpTool: a.customType({
    name: a.string().required(),
    description: a.string(),
    // JSON-encoded JSON Schema for the tool's input parameters.
    inputSchema: a.string(),
  }),

  // Result type for listMcpTools — tools array plus an optional error message.
  // error is non-null when the Lambda could reach the server but it returned an
  // error (e.g. auth failure), giving the frontend something actionable to show.
  ListMcpToolsResult: a.customType({
    tools: a.ref('McpTool').array().required(),
    error: a.string(),
  }),

  // Query: probes the given MCP server with the same url + headers the harness
  // injects as a remote_mcp tool, then returns the tool listing.
  // If this query succeeds, the agent's remote_mcp invocation will too.
  listMcpTools: a
    .query()
    .arguments({
      url: a.string().required(),
      // Pass the McpServer's headers array so the Lambda uses identical auth.
      headers: a.ref('McpServerHeaderEntry').array(),
    })
    .returns(a.ref('ListMcpToolsResult'))
    .handler(a.handler.function(listMcpTools))
    .authorization((allow) => [allow.authenticated()]),

  // Return type for the registerMcpTarget mutation
  RegisterMcpTargetResult: a.customType({
    gatewayTargetId: a.string().required(),
  }),

  // Result of completeResourceTokenAuth — success flag + a friendly error
  // message (expired session, user mismatch, AWS-side failure) when it fails.
  CompleteResourceTokenAuthResult: a.customType({
    success: a.boolean().required(),
    error: a.string(),
  }),

  // Mutation: epic #412 slice 5 (#417). The AgentCore OAuth return-URL
  // callback page (web/app/oauth/agentcore-callback) calls this once
  // AgentCore's hosted 3LO consent flow redirects back, to complete "URL
  // session binding" — proving the SAME signed-in user finished the flow —
  // before AgentCore vaults the OAuth2 token for them. `userToken` is the
  // caller's own Cognito ACCESS token (the same one forwarded as
  // `Authorization: Bearer` to the gateway for the elicited tool call — see
  // harness-agent.ts's fetchCallerIdentity/buildTools); the handler
  // cross-checks its `sub` claim against AppSync's verified identity so a
  // token belonging to a different signed-in user is rejected as a clear
  // "user mismatch" error rather than silently vaulting a token under the
  // wrong identity.
  completeResourceTokenAuth: a
    .mutation()
    .arguments({
      sessionUri: a.string().required(),
      userToken: a.string().required(),
    })
    .returns(a.ref('CompleteResourceTokenAuthResult'))
    .handler(a.handler.function(completeResourceTokenAuth))
    .authorization((allow) => [allow.authenticated()]),

  // Mutation: registers an MCP server URL as a gateway target and returns its target ID.
  // The caller is responsible for saving the returned gatewayTargetId to the McpServer record.
  registerMcpTarget: a
    .mutation()
    .arguments({
      name: a.string().required(),
      url: a.string().required(),
      description: a.string(),
    })
    .returns(a.ref('RegisterMcpTargetResult'))
    .handler(a.handler.function(registerMcpTarget))
    .authorization((allow) => [allow.authenticated()]),

  // Result type for invokeAgent mutation
  InvokeAgentResult: a.customType({
    response: a.string().required(),
    sessionId: a.string().required(),
  }),

  // Mutation: invoke a named agent synchronously and return its full response.
  // allow.guest() covers IAM-signed requests (e.g. GitHub Actions role) in
  // addition to authenticated Cognito users.
  invokeAgent: a
    .mutation()
    .arguments({
      agentSlug: a.string().required(),
      prompt: a.string().required(),
      sessionId: a.string(),
    })
    .returns(a.ref('InvokeAgentResult'))
    .handler(a.handler.function(invokeAgent))
    .authorization((allow) => [allow.authenticated(), allow.guest()]),

  // Self-join: which agents a given agent can call as sub-agents
  AgentSubAgent: a.model({
    agentId: a.id().required(),       // the caller agent
    subAgentId: a.id().required(),    // the callee agent
    agent: a.belongsTo('Agent', 'agentId'),
    subAgent: a.belongsTo('Agent', 'subAgentId'),
  }).authorization((allow) => [
    allow.authenticated().to(['read', 'create', 'update', 'delete']),
    allow.owner(),
  ]),
});
