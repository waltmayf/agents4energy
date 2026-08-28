# Use-Case Packs

A **pack** bundles everything needed to stand up one demo/starter agent — its system prompt, model, and the MCP tool server(s) it can call — as a single JSON manifest that deploys with one script against an already-running sandbox. No redeploy, no CDK changes, no manual clicking through the Agents UI.

Packs exist so a new use case (e.g. "an agent that can read/write files in S3", "an agent that queries the knowledge graph") can be authored, reviewed, and shared as a small checked-in file instead of a sequence of ad-hoc GraphQL mutations someone ran once and forgot.

## What a pack maps onto

`deploy-pack.ts` (below) turns a manifest into rows in three Amplify Data tables (see `web/amplify/data/schemas/agentConfig.schema.ts`):

| Manifest field | Table | Matched by (idempotency key) |
|---|---|---|
| `agent` | `Agent` | `slug` |
| `mcpServers[]` | `McpServer` | `name` |
| (`agent` × each `mcpServers[]`) | `AgentMcpServer` (join) | `(agentId, mcpServerId)` |
| `groupGrants[]` | `GroupToolGrant`, applied to every server in the pack | `(group, mcpServerId, toolName)` |

Re-running the deploy for the same pack is safe: each row is found-or-created, and only fields that actually differ are updated.

## Folder layout

```
packs/<pack-id>/
├─ pack.json           # required — the manifest (see schema below)
├─ system-prompt.md    # optional — referenced by agent.systemPromptFile
└─ tools/              # optional — any other files the pack wants to carry
```

`<pack-id>` is both the folder name and (by convention) the manifest's `id` field.

## `pack.json` schema

The manifest must conform to the `packManifestSchema` JSON Schema and its mirroring TypeScript type `PackManifest`, both exported from `packages/shared-types/src/packManifest.ts`.

```ts
type PackManifest = {
  id: string;
  name: string;
  description?: string;
  agent: {
    name: string;
    slug?: string;                 // derived from `name` if omitted
    description?: string;
    systemPromptText?: string;     // inline — takes precedence over systemPromptFile
    systemPromptFile?: string;     // path relative to the pack folder
    modelId?: string;
    enabled?: boolean;             // default true
  };
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
  groupGrants?: Array<{
    group: string;                 // Cognito group, e.g. "admin" | "reservoir-eng"
    toolName: string;              // exact tool name, or "*" for every tool on the server
    effect: 'ALLOW' | 'DENY';
  }>;
};
```

See `packs/example-pack/pack.json` for a minimal (non-functional, placeholder-URL) manifest, and `packs/s3-filesystem-explorer/pack.json` for a real one wired to an already-deployed tool.

## Authoring a pack

1. `mkdir packs/<pack-id>` and write `pack.json`.
2. If the agent needs a nontrivial system prompt, put it in `system-prompt.md` next to the manifest and reference it via `agent.systemPromptFile` (inline `systemPromptText` wins if both are set).
3. Point `mcpServers[].url` at a real, reachable MCP endpoint:
   - **AgentCore Gateway-backed tools** (`serverType: "agentcore"`): the URL is the *gateway's* MCP endpoint, not the underlying Lambda — every gateway-fronted tool in a given sandbox shares the same gateway URL (see `custom.agentcore_gateway_endpoint` in `web/amplify_outputs.json` after `pnpm deploy`, or the `AGENTCORE_GATEWAY_ENDPOINT` env var inside the agent runtime). **This URL is sandbox-specific** — a gateway is recreated with a new hostname per sandbox, so a pack committed with one sandbox's URL will need that field updated before deploying to a different sandbox.
   - **Public remote MCP servers**: just use the real, public URL; add `headers` for a static API key or `authSecretArn`/`oauthClientId` for the OAuth2 flow (see [`docs/mcp-server-integration.md`](mcp-server-integration.md)).
4. Add `groupGrants` for the Cognito groups that should be able to call the tool(s). This only writes `GroupToolGrant` rows (the human-editable source of truth); it is **not** itself an enforcement mechanism — see [`docs/tool-governance.md`](tool-governance.md) for how Cedar policies get generated from it. Creating/updating a grant requires the deploying user to be in the `admin` Cognito group; if the grant you declare already matches what's in the table (e.g. deploying against a sandbox that already has it), no mutation is attempted and no elevated permission is needed.

## Deploying a pack

```bash
./scripts/deploy-pack.sh <pack-id>            # apply
./scripts/deploy-pack.sh <pack-id> --dry-run  # print planned mutations only, no writes
```

This runs `scripts/deploy-pack.ts <path-to-pack.json>`, which:

1. Structurally validates the manifest against the `#472` schema.
2. Resolves the system prompt (`systemPromptText` inline, or reads `systemPromptFile` off disk).
3. Logs in as the sandbox's test user (`scripts/.env.local`: `TEST_USER_EMAIL` / `TEST_USER_PASSWORD`) and signs GraphQL requests with the resulting Cognito ID token.
4. Find-or-creates/updates the `Agent`, each `McpServer`, the `AgentMcpServer` joins, and any `GroupToolGrant` rows, in that order.

It reads the AppSync endpoint from `web/amplify_outputs.json`, so `pnpm deploy` must have run first (or you're deploying against an existing sandbox whose outputs you've copied in — see `docs/waiting-for-remote-agents.md` for how a webhook run does this).

**Packs are additive only.** Removing an entry from `pack.json` and redeploying does not delete the previously-created row — teardown is out of scope while the project is in the `development` phase (see `PROJECT_PHASE` in `CLAUDE.md`). Remove rows manually via `scripts/graphql.sh` if you need to.

## Limitation: runtime path only

A pack can only wire up MCP servers that are reachable **at runtime** with no new deploy — a plain URL (public remote MCP) or an AgentCore Gateway endpoint that's already provisioned. It **cannot** stand up a brand-new Lambda-backed tool: that requires a CDK construct pair deployed through `web/amplify/backend.ts` (a gateway-target Lambda like `web/amplify/constructs/s3ToolsGatewayTarget/` registered against the gateway, paired with a seed/registration step like `web/amplify/constructs/s3ToolsMcpServerSeed/`), which only takes effect on the next `pnpm deploy`. Packs consume tools that already exist; they don't create them.

## Worked example: `packs/s3-filesystem-explorer`

This pack wires an agent to the S3 filesystem tools already provisioned by `web/amplify/constructs/s3ToolsGatewayTarget/` (`ApplyDiff` / `ListFiles` / `ReadFile` / `DeleteFile`, issue #240) and exposed as the `McpServer` named "S3 Filesystem Tools" — the same gateway target the CDK-seeded `S3 Filesystem Demo` agent (slug `s3-filesystem-demo`) already uses. Deploying this pack creates a second, independent agent (`s3-filesystem-explorer`) that links to that same tool by matching the existing `McpServer` row by name, and reuses the `reservoir-eng` group's existing `ALLOW *` grant on that server rather than creating a new one — a concrete demonstration of the idempotent find-or-create/update path end to end, not just a schema example.

`ListFiles` also doubles as the generative-UI worked example: it returns a JSON component-spec block alongside its plain data, so the chat renderer shows a table widget instead of a YAML dump. See [`docs/mcp-generative-ui.md`](mcp-generative-ui.md) for the structured-content contract a tool uses to do this, the supported widget types, and how to add a new one.

Deployed and verified against the `web-main` sandbox by calling the `invokeAgent` GraphQL mutation with `agentSlug: "s3-filesystem-explorer"` — see the PR for the exact request/response transcript.

## Current packs

| Pack (`<pack-id>`) | Agent slug | Tool servers | What it does |
|---|---|---|---|
| `example-pack` | — | — | Minimal, non-functional placeholder-URL manifest — a schema reference, not a deployable agent. |
| `s3-filesystem-explorer` | `s3-filesystem-explorer` | S3 Filesystem Tools | Reads/writes the shared agent filesystem (see [`docs/agent-filesystem.md`](agent-filesystem.md)) — the worked example above. |
| `data-lake-analytics` | `data-lake-analytics` | Athena PySpark Tools, S3 Filesystem Tools | Runs ad-hoc PySpark queries against a data lake, saves plots/artifacts under `files/artifacts/`. See [`docs/analytics-agent.md`](analytics-agent.md). |
| `hpc-fracing-operations` | `hpc-fracing-operations` | CFD Simulation Tools, S3 Filesystem Tools, Athena PySpark Tools (optional) | Submits hydraulic-fracturing treatment plans to a PCS/Slurm/FSx CFD pipeline and returns tiered screen-out-risk recommendations with financial justification. See [`docs/hpc-fracing-agent.md`](hpc-fracing-agent.md); the `CFD Simulation Tools` server is only reachable when the backend is deployed with the `enableHpc` CDK context flag on. |

### Sandbox-specific gateway URLs — a caveat that applies to every AgentCore-Gateway-backed pack

Both `data-lake-analytics` and `hpc-fracing-operations` (like `s3-filesystem-explorer` before
them) commit an `mcpServers[].url` that points at the AgentCore Gateway endpoint of the
sandbox they were authored against, plus (for some entries) a `gatewayTargetId`. Both fields
are **sandbox-specific** — see step 3 under "Authoring a pack" above and each pack's own
`README.md` (where present) for the exact refresh procedure: pull the current
`custom.agentcore_gateway_endpoint` out of `web/amplify_outputs.json` for `url`, and
`aws bedrock-agentcore-control list-gateway-targets --gateway-identifier <gateway-id>` for
`gatewayTargetId`, before running `deploy-pack.sh` against any sandbox other than the one the
pack was committed from. A stale or omitted `gatewayTargetId` isn't harmless — `deploy-pack.ts`
overwrites an existing `McpServer` row's `gatewayTargetId` with whatever the manifest
specifies (including clearing it to `null` if the field is omitted), which can null out a
working row. In practice the seed constructs that own these `McpServer` rows
(`athenaPySparkMcpServerSeed`, `cfdToolsMcpServerSeed`, `s3ToolsMcpServerSeed`) re-correct
`url`/`gatewayTargetId` on their own next deploy even if a pack's `deploy-pack.sh` run created
or clobbered the row first — but there's a window where the tool is unreachable in between.
