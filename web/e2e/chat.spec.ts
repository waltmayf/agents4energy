import { test, expect } from '@playwright/test';

// These tests run on the storageState produced by auth.setup.ts, which signs in
// as the SSM-provisioned test user (/agentcore/e2e-test-user-web-main/*).
//
// The chat page renders with CopilotKit's <CopilotChat> (AG-UI), backed by the
// client-side HarnessAgent in web/lib/harness-agent.ts. Selectors below target
// CopilotKit's stable test ids / class names:
//   - textarea:          [data-testid="copilot-chat-textarea"]
//   - user message:      .copilotKitUserMessage
//   - assistant message: [data-testid="copilot-assistant-message"]

test.describe('Chat page (AG-UI / CopilotKit)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('chat');
    // Auth gate should be gone — storageState from auth.setup.ts handles login.
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible();
    // The page bootstraps a session (?sessionId=...) before the chat is usable.
    await page.waitForURL(/[?&]sessionId=/, { timeout: 20_000 });
  });

  test('prompt input is visible and accepts text', async ({ page }) => {
    const textarea = page.getByTestId('copilot-chat-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('Hello');
    await expect(textarea).toHaveValue('Hello');
  });

  test('agent streams a response after sending a message', async ({ page }) => {
    const textarea = page.getByTestId('copilot-chat-textarea');
    // Ask for a sentinel that does NOT appear in the prompt itself, so matching
    // the assistant bubble can't be satisfied by echoing the user's text.
    await textarea.fill('Output only this 5-character code, nothing else: Z X Q 4 2 (remove the spaces)');
    await textarea.press('Enter');

    // User bubble appears immediately.
    await expect(page.locator('.copilotKitUserMessage').last()).toBeVisible();

    // Assistant reply streams in and contains the sentinel token.
    await expect(page.getByTestId('copilot-assistant-message').last()).toContainText('ZXQ42', {
      timeout: 60_000,
    });
  });

  test('new messages written to the session appear live without a reload', async ({ page, context }) => {
    // Establish a turn in this tab so the session exists in AgentCore memory.
    const textarea = page.getByTestId('copilot-chat-textarea');
    await textarea.fill('Output only this 5-character code, nothing else: A B C 1 2 (remove the spaces)');
    await textarea.press('Enter');
    await expect(page.getByTestId('copilot-assistant-message').last()).toContainText('ABC12', {
      timeout: 60_000,
    });

    // The XYZ99 sentinel must not already be present in this tab.
    const sessionUrl = page.url();
    expect(sessionUrl).toMatch(/[?&]sessionId=/);
    await expect(page.getByText('XYZ99')).toHaveCount(0);

    // Simulate an external writer (e.g. a webhook harness run) on the SAME
    // session by opening it in a second tab and sending a distinct turn. This
    // writes new turns to the shared AgentCore session without touching the
    // first tab.
    const writer = await context.newPage();
    await writer.goto(sessionUrl);
    await expect(writer.getByRole('button', { name: 'Sign in' })).not.toBeVisible();
    const writerBox = writer.getByTestId('copilot-chat-textarea');
    await writerBox.fill('Output only this 5-character code, nothing else: X Y Z 9 9 (remove the spaces)');
    await writerBox.press('Enter');
    await expect(writer.getByTestId('copilot-assistant-message').last()).toContainText('XYZ99', {
      timeout: 60_000,
    });
    await writer.close();

    // The first tab must pick up the externally-written XYZ99 turn via polling —
    // WITHOUT any navigation or reload. This is the regression guard: history
    // only reloads on (re)mount, so the sentinel surfacing here proves polling
    // re-fetches AgentCore memory and pushes it into the live transcript. The
    // generous timeout absorbs memory-persistence lag plus the poll interval.
    // (Asserted anywhere in the transcript, not on `.last()`, because stored
    // history can come back out of send-order — see the note below.)
    await expect(page.getByTestId('copilot-assistant-message').filter({ hasText: 'XYZ99' })).toHaveCount(1, {
      timeout: 60_000,
    });
  });

  test('conversation history is restored on reload', async ({ page }) => {
    const textarea = page.getByTestId('copilot-chat-textarea');
    await textarea.fill('Output only this 5-character code, nothing else: Z X Q 4 2 (remove the spaces)');
    await textarea.press('Enter');

    // Wait for the assistant reply to finish streaming before reloading, so the
    // turn is persisted to AgentCore Memory.
    await expect(page.getByTestId('copilot-assistant-message').last()).toContainText('ZXQ42', {
      timeout: 60_000,
    });

    // The session id is in the URL; reloading re-mounts <CopilotChat> with the
    // same threadId, which triggers HarnessAgent.connect() → MESSAGES_SNAPSHOT.
    const sessionUrl = page.url();
    expect(sessionUrl).toMatch(/[?&]sessionId=/);

    await page.goto(sessionUrl);
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible();

    // Both the user prompt and the assistant reply come back from memory.
    await expect(page.locator('.copilotKitUserMessage').last()).toContainText(
      'Output only this 5-character code',
      { timeout: 30_000 },
    );
    await expect(page.getByTestId('copilot-assistant-message').last()).toContainText('ZXQ42', {
      timeout: 30_000,
    });
  });
});
