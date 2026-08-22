import { test, expect, type Page } from '@playwright/test';
import { E2E_MCP_PREFIX, deleteMcpServersByIds } from './mcp-server-cleanup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every McpServer this suite creates is tracked here and deleted directly via
// the AppSync API in afterAll (issue #308) — an API delete can't be skipped by
// a timed-out UI assertion the way the old UI-driven cleanup could, so orphans
// no longer accumulate in the shared sandbox. All names use the E2E_MCP_PREFIX
// sentinel so the global-setup purge (mcp-cleanup.setup.ts) can also sweep any
// that still slip through.
const createdServerIds: string[] = [];

/** Build a unique, sentinel-prefixed server name so cleanup can always find it. */
function e2eServerName(label: string): string {
  return `${E2E_MCP_PREFIX}${label} ${Date.now()}`;
}

test.afterAll(async () => {
  await deleteMcpServersByIds(createdServerIds);
  createdServerIds.length = 0;
});

async function goToMcpServersTab(page: Page) {
  await page.goto('agents');
  await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tab-mcp-servers').click();
}

/** Create a new MCP server. Returns the saved record's ID. */
async function createMcpServer(
  page: Page,
  opts: { name: string; url: string; oauthClientId?: string },
): Promise<string> {
  await page.getByTestId('new-mcp-server-button').click();
  await page.getByTestId('input-mcp-name').fill(opts.name);
  await page.getByTestId('input-mcp-url').fill(opts.url);
  if (opts.oauthClientId) {
    await page.getByTestId('input-mcp-oauth-client-id').fill(opts.oauthClientId);
  }
  await page.getByTestId('save-mcp-server-button').click();

  // After save the delete button appears (only visible on existing records).
  await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 10_000 });

  // Find the row by name — each call uses a unique name so this is unambiguous.
  const row = page.locator('[data-testid^="mcp-server-row-"]').filter({ hasText: opts.name });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const testId = (await row.getAttribute('data-testid')) ?? '';
  const id = testId.replace('mcp-server-row-', '');
  // Track for API-based teardown so a later timed-out assertion can't orphan it.
  if (id) createdServerIds.push(id);
  return id;
}

/** Close any open dialog (Escape), then delete the server with the given ID. */
async function deleteMcpServer(page: Page, serverId: string) {
  // Dismiss any open dialog that would intercept clicks.
  await page.keyboard.press('Escape');

  const row = page.getByTestId(`mcp-server-row-${serverId}`);
  if (!(await row.isVisible())) return;
  await row.click();

  await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('delete-mcp-server-button').click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId(`mcp-server-row-${serverId}`)).not.toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

test.describe('MCP Servers tab', () => {
  test.beforeEach(async ({ page }) => {
    await goToMcpServersTab(page);
  });

  test('tab is visible and switches from Agents tab', async ({ page }) => {
    await expect(page.getByTestId('tab-mcp-servers')).toBeVisible();
    await expect(page.getByTestId('new-mcp-server-button')).toBeVisible();
    await expect(page.getByTestId('edit-panel')).not.toBeVisible();
  });

  test('shows empty state or server list', async ({ page }) => {
    const list = page.getByTestId('mcp-server-sidebar-list');
    const emptyState = page.getByText('No MCP servers yet');
    await expect(list.or(emptyState)).toBeVisible();
  });

  test('switching back to Agents tab hides MCP panel', async ({ page }) => {
    await page.getByTestId('new-mcp-server-button').click();
    await expect(page.getByTestId('mcp-server-edit-panel')).toBeVisible();

    await page.getByTestId('tab-agents').click();
    await expect(page.getByTestId('mcp-server-edit-panel')).not.toBeVisible();
    await expect(page.getByTestId('new-agent-button')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// MCP server form
// ---------------------------------------------------------------------------

test.describe('MCP server create / edit', () => {
  test.beforeEach(async ({ page }) => {
    await goToMcpServersTab(page);
    await page.getByTestId('new-mcp-server-button').click();
  });

  test('shows empty edit panel with all fields', async ({ page }) => {
    await expect(page.getByTestId('mcp-server-edit-panel')).toBeVisible();
    await expect(page.getByTestId('input-mcp-name')).toBeVisible();
    await expect(page.getByTestId('input-mcp-url')).toBeVisible();
    await expect(page.getByTestId('input-mcp-oauth-client-id')).toBeVisible();
    await expect(page.getByTestId('input-mcp-oauth-audience')).toBeVisible();
  });

  // Issue #470: oauthAudience is a plain optional string field on McpServer,
  // saved/reloaded the same way as oauthClientId.
  test('oauthAudience round-trips through save and reload', async ({ page }) => {
    const name = e2eServerName('Audience Test');
    await page.getByTestId('input-mcp-name').fill(name);
    await page.getByTestId('input-mcp-url').fill('https://audience-test.invalid/mcp');
    await page.getByTestId('input-mcp-oauth-client-id').fill('test-client-id-456');
    await page.getByTestId('input-mcp-oauth-audience').fill('https://gateway.example/mcp');
    await page.getByTestId('save-mcp-server-button').click();

    await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 10_000 });
    const row = page.locator('[data-testid^="mcp-server-row-"]').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const testId = (await row.getAttribute('data-testid')) ?? '';
    const id = testId.replace('mcp-server-row-', '');
    if (id) createdServerIds.push(id);

    // Reload and reselect — the saved value should come back from the API.
    await page.reload();
    await page.getByTestId('tab-mcp-servers').click();
    await page.getByTestId(`mcp-server-row-${id}`).click();
    await expect(page.getByTestId('input-mcp-oauth-audience')).toHaveValue('https://gateway.example/mcp');
  });

  test('shows error when name is missing', async ({ page }) => {
    await page.getByTestId('save-mcp-server-button').click();
    await expect(page.getByText('Name is required')).toBeVisible();
  });

  test('shows error when URL is missing', async ({ page }) => {
    await page.getByTestId('input-mcp-name').fill('Test Server');
    await page.getByTestId('save-mcp-server-button').click();
    await expect(page.getByText('URL is required')).toBeVisible();
  });

  test('close button dismisses the panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page.getByTestId('mcp-server-edit-panel')).not.toBeVisible();
  });

  test('can add and remove auth headers', async ({ page }) => {
    await page.getByRole('button', { name: 'Add header' }).click();
    const keyInput = page.locator('input[placeholder="Header name"]');
    await expect(keyInput).toHaveCount(1);
    await keyInput.fill('Authorization');
    await page.locator('input[placeholder="Value"]').fill('Bearer token123');

    await page.getByRole('button', { name: 'Remove header' }).click();
    await expect(keyInput).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// OAuth credential section
// ---------------------------------------------------------------------------

test.describe('OAuth credential section', () => {
  // Create one server for the whole describe block, delete it afterward.
  let serverId: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: '.auth/user.json' });
    const p = await ctx.newPage();
    await goToMcpServersTab(p);
    serverId = await createMcpServer(p, {
      name: e2eServerName('OAuth Test'),
      url: 'https://example.invalid/mcp',
      oauthClientId: 'test-client-id-123',
    });
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: '.auth/user.json' });
    const p = await ctx.newPage();
    await goToMcpServersTab(p);
    await deleteMcpServer(p, serverId);
    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    await goToMcpServersTab(page);
    await page.getByTestId(`mcp-server-row-${serverId}`).click();
    await expect(page.getByTestId('mcp-server-edit-panel')).toBeVisible();
  });

  // @harness-stream — quarantined (#285): fails against the current deployed
  // sandbox alongside the harness-streaming suite. Excluded from the CI e2e
  // gate via --grep-invert @harness-stream; runs locally by default.
  test('credential section appears when oauthClientId is set', { tag: '@harness-stream' }, async ({ page }) => {
    await expect(page.getByTestId('credential-section')).toBeVisible();
    await expect(page.getByTestId('credential-status')).toBeVisible();
  });

  test('shows not-authenticated state and Authenticate button', async ({ page }) => {
    await expect(page.getByTestId('credential-status')).toContainText('Not authenticated', {
      timeout: 5_000,
    });
    await expect(page.getByTestId('authenticate-button')).toBeVisible();
    await expect(page.getByTestId('revoke-button')).not.toBeVisible();
  });

  test('credential section hidden after clearing oauthClientId and saving', async ({ page }) => {
    await page.getByTestId('input-mcp-oauth-client-id').clear();
    await page.getByTestId('save-mcp-server-button').click();
    await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('credential-section')).not.toBeVisible();

    // Restore oauthClientId for subsequent tests.
    await page.getByTestId('input-mcp-oauth-client-id').fill('test-client-id-123');
    await page.getByTestId('save-mcp-server-button').click();
    await expect(page.getByTestId('delete-mcp-server-button')).toBeVisible({ timeout: 10_000 });
  });

  // ── Auth popup flow ────────────────────────────────────────────────────────
  //
  // We can't automate a real OAuth login through a Cognito hosted UI in a
  // headless browser, so these tests validate the UI-side behaviour:
  // that clicking Authenticate triggers a popup and shows the "Opening
  // sign-in window…" state. The test blocks the popup window (no URL can
  // actually complete the OIDC discovery on example.invalid) and verifies
  // the error state that follows.

  test.describe('auth popup flow', () => {
    test('Authenticate button triggers auth flow (shows loading or error)', async ({ page }) => {
      // Clicking Authenticate starts the PKCE flow. For example.invalid, the
      // OIDC discovery fetch will fail (network error / DNS failure), so the
      // credential section ends up in an error state. We just verify the button
      // is no longer idle and the error state eventually appears.
      await expect(page.getByTestId('authenticate-button')).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('authenticate-button').click();

      // Wait for the credential status to transition away from the idle "Not authenticated" state.
      // It may go through "Opening sign-in window…" briefly, then land on an error.
      await expect(page.getByTestId('credential-status')).not.toContainText('Not authenticated', {
        timeout: 15_000,
      });
    });

    test('no dialog opens — auth happens inline', async ({ page }) => {
      // The old flow opened a modal dialog. The new flow is inline — no dialog role.
      // Click authenticate and verify no dialog appears.
      await expect(page.getByTestId('authenticate-button')).toBeVisible({ timeout: 5_000 });
      await page.getByTestId('authenticate-button').click();

      // Allow a moment for any dialog to appear (it shouldn't).
      await page.waitForTimeout(300);
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// Full create → row appears → select → delete lifecycle
// ---------------------------------------------------------------------------

test.describe('MCP server lifecycle', () => {
  test('create, verify row appears, then delete', async ({ page }) => {
    await goToMcpServersTab(page);

    const name = e2eServerName('Lifecycle Test');
    const serverId = await createMcpServer(page, {
      name,
      url: 'https://lifecycle.invalid/mcp',
    });

    // Row visible in sidebar with URL shown
    await expect(page.getByTestId(`mcp-server-row-${serverId}`)).toBeVisible();
    await expect(page.getByTestId(`mcp-server-row-${serverId}`)).toContainText('lifecycle.invalid');

    // No oauthClientId → no credential section
    await expect(page.getByTestId('credential-section')).not.toBeVisible();

    // Delete and confirm gone
    await deleteMcpServer(page, serverId);
    await expect(page.getByTestId(`mcp-server-row-${serverId}`)).not.toBeVisible();
  });
});
