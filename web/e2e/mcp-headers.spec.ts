import { test, expect } from '@playwright/test';

test.describe('MCP Server Header UI', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the agents page which includes the MCP server tab
    await page.goto('/agents');
    // Ensure we are signed in via stored auth state (handled by global setup)
    await expect(page.getByTestId('tab-mcp-servers')).not.toBeHidden();
  });

  test('header editor appears when creating a new MCP server', async ({ page }) => {
    // Switch to MCP Servers tab
    await page.getByTestId('tab-mcp-servers').click();
    // Click the button to add a new server
    await page.getByTestId('new-mcp-server-button').click();
    // The edit panel should appear
    await expect(page.getByTestId('mcp-server-edit-panel')).toBeVisible();
    // The "Add header" button should be present
    const addHeaderBtn = page.getByRole('button', { name: /Add header/i });
    await expect(addHeaderBtn).toBeVisible();
    // Click to add a header row and verify inputs appear
    await addHeaderBtn.click();
    const headerKeyInput = page.getByPlaceholder('Header name');
    const headerValueInput = page.getByPlaceholder('Value');
    await expect(headerKeyInput).toBeVisible();
    await expect(headerValueInput).toBeVisible();
  });
});
