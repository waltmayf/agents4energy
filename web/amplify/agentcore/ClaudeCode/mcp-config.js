// Writes the single `.mcp.json` the `claude` CLI loads via `--mcp-config`,
// merging every enabled MCP server entry (AgentCore Browser, AgentCore
// gateway, ...) into one file (issue #339) so each job needs exactly one
// `--mcp-config` flag regardless of which tool sources are available.

import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MCP_CONFIG_FILENAME = '.mcp-agentcore.json';

/** Returns null (no file written) when `mcpServers` has no entries. */
export async function writeMcpConfig(workDir, mcpServers) {
  if (!Object.keys(mcpServers).length) return null;
  const mcpConfigPath = join(workDir, MCP_CONFIG_FILENAME);
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2));
  return mcpConfigPath;
}

export async function removeMcpConfig(mcpConfigPath) {
  if (!mcpConfigPath) return;
  await rm(mcpConfigPath, { force: true }).catch(() => {});
}
