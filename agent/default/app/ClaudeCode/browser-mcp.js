// Wires the built-in AgentCore Browser tool into Claude Code as an MCP server
// (issue #183), mirroring how MyHarness exposes `agentcore_browser` to the
// harness half (see agent/default/agentcore/agentcore.json's `runtimes[].connections`
// on ClaudeCode, which grants this runtime's execution role
// bedrock-agentcore:StartBrowserSession/etc. on the AWS-managed default browser).
//
// Claude Code speaks MCP natively but has no built-in browser tool, so we:
//   1. Start an AgentCore Browser session via the `bedrock-agentcore` SDK.
//   2. Generate a SigV4-signed CDP WebSocket URL + auth headers for it.
//   3. Point `@playwright/mcp` at that CDP endpoint (`--cdp-endpoint`/`--cdp-header`)
//      instead of launching its own local Chromium — it becomes a thin MCP
//      wrapper over the already-running, AWS-managed remote browser.
//   4. Write a `.mcp.json` the `claude` CLI loads via `--mcp-config`, so the
//      model gets navigate/click/type/screenshot/etc. tools through the
//      standard MCP tool-call surface.
//
// One browser session per Claude Code job (not shared across concurrent runs
// on the same microVM) — sessions are cheap to start/stop and isolating them
// avoids one job's navigation clobbering another's.

import { Browser } from 'bedrock-agentcore/browser';
import { writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Resolve @playwright/mcp's CLI entrypoint from THIS package's own
// node_modules (it's a pinned dependency baked into the container image at
// build time — see package.json/Dockerfile) rather than shelling out to
// `npx`, which would hit the network at runtime and could resolve a
// different version than the one the image was built and tested against.
// @playwright/mcp's package.json only exports "." and "./package.json" (no
// "./cli.js" subpath), so resolve the package.json and join cli.js from its
// directory rather than require.resolve-ing cli.js directly.
const require = createRequire(import.meta.url);
const PLAYWRIGHT_MCP_CLI = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');

// Starts a fresh AgentCore Browser session and returns everything needed to
// tear it down later plus the `.mcp.json` config Claude Code should load.
export async function startBrowserMcp({ workDir, log }) {
  const browser = new Browser({ region: AWS_REGION });
  // Claude Code jobs can run for hours (see server.js's callback-path
  // comments — the webhook's state machine task timeout is 3h), so use the
  // AgentCore Browser session's max timeout (8h) rather than its 1h default,
  // or a long-running job's browser tool would start failing mid-run.
  await browser.startSession({ sessionName: `claude-code-${Date.now()}`, timeout: 28800 });
  const { url, headers } = await browser.generateWebSocketUrl();

  const mcpConfigPath = join(workDir, '.mcp-agentcore-browser.json');
  const cdpHeaderArgs = Object.entries(headers).flatMap(([name, value]) => [
    '--cdp-header',
    `${name}: ${value}`,
  ]);
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          'agentcore-browser': {
            command: process.execPath,
            args: [PLAYWRIGHT_MCP_CLI, '--cdp-endpoint', url, ...cdpHeaderArgs],
          },
        },
      },
      null,
      2,
    ),
  );
  log(`[browser-mcp] started AgentCore Browser session, wrote MCP config to ${mcpConfigPath}`);

  return {
    mcpConfigPath,
    async stop() {
      await rm(mcpConfigPath, { force: true }).catch(() => {});
      try {
        await browser.stopSession();
        log('[browser-mcp] stopped AgentCore Browser session');
      } catch (err) {
        log('[browser-mcp] error stopping AgentCore Browser session:', err?.message || String(err));
      }
    },
  };
}
