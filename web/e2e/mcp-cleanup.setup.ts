import { test as setup } from '@playwright/test';
import { purgeE2eMcpServers } from './mcp-server-cleanup';

// Global startup purge (issue #308): before the suite runs, delete every
// e2e-created McpServer left behind by a previous run (a run whose teardown was
// skipped by a timed-out hook). This keeps the shared deployed sandbox's
// McpServer table small so the create/list round-trip stays well under the test
// timeouts. Runs as a setup-project dependency of the chromium project, after
// auth.setup.ts. Never fails the run — a purge error just logs and continues.
setup('purge orphaned e2e MCP servers', async () => {
  await purgeE2eMcpServers();
});
