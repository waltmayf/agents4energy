# Data Lake Analytics pack

See `pack.json` (manifest) and `system-prompt.md` (agent prompt). Follows the
schema in [`packs/README.md`](../README.md).

## Sandbox-specific values — refresh before deploying

`mcpServers[].url` and `mcpServers[].gatewayTargetId` are specific to the
sandbox this pack was authored against. Before running
`./scripts/deploy-pack.sh data-lake-analytics`, refresh both from the
deployed backend:

- `url` — `web/amplify_outputs.json`'s `custom.agentcore_gateway_endpoint`
  (same AgentCore Gateway endpoint used by every McpServer in a given
  sandbox).
- `gatewayTargetId` — the target id AWS assigned when the gateway target was
  registered (`aws bedrock-agentcore-control list-gateway-targets
  --gateway-identifier <gateway-id>`). This field is optional in the
  manifest, but if present it must match the live target: `deploy-pack.ts`
  overwrites an existing `McpServer` row's `gatewayTargetId` with whatever
  the manifest specifies (including `null` if omitted), so a stale or
  missing value here will clobber a working row on the next `deploy-pack.sh`
  run.

The `Athena PySpark Tools` McpServer this pack references is seeded by the
`AthenaPySparkMcpServerSeed` construct (#501,
`web/amplify/constructs/athenaPySparkMcpServerSeed/`) — that construct owns
the authoritative `url`/`gatewayTargetId` for that row and will correct them
on its next deploy even if this pack creates the row first without them.
