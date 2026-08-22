# Packs Folder Convention

> For the fuller walkthrough (authoring steps, the three-table mapping, a worked example, and the Lambda-backed-tools limitation), see [`docs/use-case-packs.md`](../docs/use-case-packs.md).

This repository defines **use‑case packs** that bundle an Agent, its MCP servers (tools), and optional group‑tool grants. A pack lives in its own folder under `packs/` and follows this layout:

```
packs/<pack-id>/
├─ pack.json            # Manifest describing the pack (see schema below)
├─ system-prompt.md    # Optional markdown file referenced by pack.json
└─ tools/               # Optional additional files (e.g. tool assets)
```

## `pack.json` schema

The manifest must conform to the JSON Schema exported as `packManifestSchema` in
`packages/shared-types/src/packManifest.ts`.  The TypeScript type `PackManifest`
(described in the same file) mirrors that schema.

| Field | Description | Maps to |
|-------|-------------|----------|
| `id` | Unique identifier for the pack; also the folder name. | — |
| `name` | Human‑readable name of the pack. | — |
| `description` | Optional free‑form description. | — |
| `agent` | Agent configuration. | `Agent` table rows (`name`, `slug`, `description`, `systemPromptText`/`systemPromptFile`, `modelId`, `enabled`). |
| `agent.systemPromptText` | Inline system prompt. Takes precedence over `systemPromptFile`. | `Agent.systemPromptText` |
| `agent.systemPromptFile` | Path (relative to the pack folder) to a markdown file containing the system prompt. | Read from disk by `deploy-pack.ts` and written inline to `Agent.systemPromptText` (no S3 upload in v1). |
| `mcpServers` | Array of MCP server definitions. | `McpServer` table rows (fields listed in the schema). |
| `groupGrants` | Optional per‑group tool grants (`group`, `toolName`, `effect`). Not scoped to a specific `mcpServer` in the manifest — `deploy-pack.ts` applies each grant to every `McpServer` in the same pack. | `GroupToolGrant` rows (`group`, `mcpServerId`, `toolName`, `effect`). |

### Example manifest (see `packs/example-pack/pack.json`)

```json
{
  "id": "example-pack",
  "name": "Example Pack",
  "description": "A minimal example pack used for documentation and testing.",
  "agent": {
    "name": "Example Agent",
    "slug": "example-agent",
    "description": "Agent bundled in the example pack.",
    "systemPromptFile": "system-prompt.md",
    "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "enabled": true
  },
  "mcpServers": [
    {
      "name": "Example MCP Server",
      "url": "https://example.com/api",
      "description": "Demo MCP endpoint.",
      "serverType": "mcp",
      "headers": [{ "key": "Authorization", "value": "Bearer token" }],
      "enabled": true
    }
  ],
  "groupGrants": [
    { "group": "admin", "toolName": "*", "effect": "ALLOW" }
  ]
}
```

The optional `system-prompt.md` file lives alongside `pack.json` and contains the agent’s system prompt text.

---

## Deploying a pack

`scripts/deploy-pack.ts` (via the `scripts/deploy-pack.sh <pack-id>` wrapper) reads a pack's manifest and idempotently provisions it against the deployed backend over authenticated GraphQL — no redeploy needed for URL/gateway MCP tools:

```bash
./scripts/deploy-pack.sh example-pack            # apply
./scripts/deploy-pack.sh example-pack --dry-run  # print planned mutations only
```

It find-or-creates/updates the `Agent` (matched by `slug`), each `McpServer` (matched by `name`), the `AgentMcpServer` joins, and any `GroupToolGrant` rows — safe to re-run.

**Packs are additive only.** Deleting an entry from `pack.json` and re-running `deploy-pack.sh` does **not** delete the previously-created row — teardown/deletion is out of scope while the project is in the `development` phase (see `PROJECT_PHASE` in `CLAUDE.md`). Remove rows manually via `scripts/graphql.sh` if needed.
