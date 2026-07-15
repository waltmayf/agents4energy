/**
 * E2E regression guard for LIVE tool-call rendering.
 *
 * The bug (fixed in web/lib/harness-stream-to-agui.ts): the live InvokeHarness
 * stream loop only translated *text* deltas into AG-UI events, silently
 * dropping `toolUse`/`toolResult` blocks. Tool activity therefore only appeared
 * AFTER a reload (which rebuilds it from AgentCore memory via
 * converse-to-agui.ts), never during the live turn — exactly the "I see tool
 * calls on reload but not live" symptom.
 *
 * This test forces a live tool call using the default harness's built-in shell
 * tool and asserts the tool-call card ([data-testid="tool-call"], rendered by
 * ToolCallRenderer) shows up WITHOUT a reload.
 *
 * NOTE on the reload step: the default harness persists BUILT-IN tool calls to
 * memory as flattened text (no structured toolUse/toolResult blocks), so the
 * reloaded transcript restores the conversation text but does NOT reconstruct a
 * tool-call card for the shell tool. That memory-format gap is tracked
 * separately in issue #117; MCP-server tool calls (which DO persist structured blocks) are
 * covered by the converse-to-agui unit tests. So here we only assert the live
 * card, plus that the reload restores the turn.
 */
import { test, expect } from '@playwright/test';

// The built-in shell tool surfaces in the tool-call card by this name.
const SHELL_TOOL_NAME = 'shell';
// Long timeout: a live turn invokes the model, runs the tool, then answers.
const TURN_TIMEOUT = 120_000;

test.describe('Chat page — live tool calls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('chat');
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible({ timeout: 15_000 });
    await page.waitForURL(/[?&]sessionId=/, { timeout: 20_000 });
  });

  test('tool calls render live during the turn, without a reload', async ({ page }) => {
    // The whole flow (two model turns around a tool call, then a reload) can run
    // past Playwright's 30s default.
    test.setTimeout(TURN_TIMEOUT * 2);

    // Force a tool call: naming the command and the tool makes the model invoke
    // the built-in shell tool rather than answering from memory.
    const textarea = page.getByTestId('copilot-chat-textarea');
    await textarea.fill(
      'Run the shell command `echo HELLO_FROM_SHELL_42` using your bash/shell tool ' +
        'and report the exact output. You MUST use the tool — do not answer from memory.',
    );
    await textarea.press('Enter');

    // User bubble appears immediately.
    await expect(page.locator('.copilotKitUserMessage').last()).toBeVisible();

    // THE REGRESSION GUARD: a tool-call card must appear during the LIVE turn,
    // before any navigation/reload. Pre-fix, this never happened — tool activity
    // only surfaced after a reload rebuilt it from memory.
    const toolCard = page.locator('[data-testid="tool-call"]');
    await expect(toolCard.first()).toBeVisible({ timeout: TURN_TIMEOUT });

    // The card names the shell tool and reaches the completed ("done") state,
    // which proves the toolUse START/ARGS/END + toolResult were all translated.
    await expect(toolCard.first()).toContainText(SHELL_TOOL_NAME, { timeout: 5_000 });
    await expect(toolCard.first()).toContainText('done', { timeout: TURN_TIMEOUT });

    // The assistant's final answer streams in after the tool result.
    await expect(page.getByTestId('copilot-assistant-message').last()).toContainText(
      'HELLO_FROM_SHELL_42',
      { timeout: TURN_TIMEOUT },
    );

    // Reload: the conversation is restored from AgentCore memory. (The built-in
    // shell tool isn't persisted as a structured tool block, so we assert the
    // turn's text is restored rather than a reconstructed tool card.)
    const sessionUrl = page.url();
    await page.goto(sessionUrl);
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible();
    await expect(page.getByText('HELLO_FROM_SHELL_42').first()).toBeVisible({ timeout: 30_000 });
  });
});
