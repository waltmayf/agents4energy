# Packs Folder Convention

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
| `agent.systemPromptFile` | Path (relative to the pack folder) to a markdown file containing the system prompt. | `Agent.systemPromptS3Key` will be populated at runtime from the file content. |
| `mcpServers` | Array of MCP server definitions. | `McpServer` table rows (fields listed in the schema). |
| `groupGrants` | Optional per‑group tool grants. | `GroupToolGrant` rows (`group`, `toolName`, `effect`). |

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

When a pack is applied, the CLI or automation scripts will read the manifest, create or update the corresponding `Agent`, `McpServer`, and `GroupToolGrant` rows, and upload any referenced markdown files to S3 as needed.
