import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { BedrockAgentCoreClient, CreateEventCommand } from '@aws-sdk/client-bedrock-agentcore';

// Verifies the "webhook run → live chat view" flow described in
// docs/webhook-stepfunction-integration.md ("CloudWatch Logs Live Tail link")
// and docs/agentic-architecture.md ("Viewing past sessions"): a webhook run's
// initial comment links to `/chat?sessionId=<runId>`, and the browser polls
// AgentCore memory (`use-session-message-polling.ts`) so turns written to that
// session by something other than the viewing tab still show up live.
//
// A real GitHub/Jira webhook delivery isn't something CI can trigger end to
// end, so this test simulates the part that matters for the browser: it opens
// `/chat?sessionId=<id>` for a session id nobody in this tab has written to
// yet (exactly the state right after a webhook's initial comment is posted),
// then writes directly to AgentCore Memory under that same id — the same
// CreateEvent call the ClaudeCode AgentCore Runtime makes for its own turns
// (web/amplify/agentcore/ClaudeCode/memory.js) and the harness itself makes
// implicitly on every turn — and asserts the polling picks it up without a
// reload. This exercises the exact read path a live webhook run would produce
// (list-session-messages -> converse-to-agui -> HarnessAgent.refreshHistory),
// without spending real harness/Bedrock time.
//
// `runtimeSessionId`/AgentCore session ids must be at least 33 characters
// (InvokeHarnessCommand's own constraint, see scripts/invoke.ts) — a UUID
// satisfies that, matching what agent-webhook-invoke-agent uses as the real
// runId/runtimeSessionId.
const ACTOR_ID = 'default';

const root = resolve(__dirname, '../..');
const e2eConfigPath = resolve(root, 'web/e2e-config.json');
const cfg = existsSync(e2eConfigPath)
  ? (JSON.parse(readFileSync(e2eConfigPath, 'utf8')) as { region?: string })
  : null;
const region = cfg?.region ?? process.env.AWS_REGION ?? 'us-east-1';

// The memory id isn't published to e2e-config.json (it's an internal wiring
// detail, not needed by the browser or by auth.setup.ts). Prefer
// amplify_outputs.json (present for a local `pnpm deploy` / dev-server run —
// same file scripts/invoke.ts reads for the harness ARN) and fall back to an
// env var for CI, where only e2e-config.json is fetched from SSM.
const amplifyOutputsPath = resolve(root, 'web/amplify_outputs.json');
const amplifyOutputsMemoryId = existsSync(amplifyOutputsPath)
  ? (JSON.parse(readFileSync(amplifyOutputsPath, 'utf8'))?.custom?.agentcore_memory_id as string | undefined)
  : undefined;
const memoryId = amplifyOutputsMemoryId ?? process.env.AGENTCORE_MEMORY_ID;

test.describe('Webhook chat-session live view (issue #64)', () => {
  test.skip(
    !memoryId,
    'No AgentCore memory id available — run against a deployed backend with web/amplify_outputs.json present, or set AGENTCORE_MEMORY_ID',
  );

  test('messages written directly to AgentCore memory for a session appear live in /chat?sessionId=<id>', async ({ page }) => {
    test.setTimeout(60_000);

    const agentCore = new BedrockAgentCoreClient({ region });
    // A fresh, never-before-seen session id — mirrors a webhook run's runId,
    // which doubles as the ChatSession id the browser link uses and the
    // harness's own runtimeSessionId (docs/webhook-stepfunction-integration.md
    // "CloudWatch Logs Live Tail link").
    const sessionId = randomUUID();
    const sentinel = `E2E-WEBHOOK-LIVE-${randomUUID().slice(0, 8).toUpperCase()}`;

    // Open the deep link exactly as a webhook's initial comment would —
    // before anything has been written to this session yet.
    await page.goto(`chat?sessionId=${sessionId}`);
    await expect(page.getByRole('button', { name: 'Sign in' })).not.toBeVisible();
    await expect(page.getByTestId('copilot-chat-textarea')).toBeVisible();
    await expect(page.getByText(sentinel)).toHaveCount(0);

    // Simulate the "external run" half of the flow: write a user turn then an
    // assistant turn to the SAME session, via the same CreateEvent call a real
    // harness/ClaudeCode turn would make — see web/amplify/agentcore/ClaudeCode/memory.js.
    // The harness's stored payload is a Converse ContentBlock[] JSON string
    // (see web/amplify/functions/list-session-messages/handler.ts), which is
    // what converse-to-agui.ts expects for contentJson.
    await agentCore.send(new CreateEventCommand({
      memoryId,
      actorId: ACTOR_ID,
      sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: 'USER', content: { text: JSON.stringify([{ text: 'What is the status?' }]) } } }],
    }));
    await agentCore.send(new CreateEventCommand({
      memoryId,
      actorId: ACTOR_ID,
      sessionId,
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: 'ASSISTANT', content: { text: JSON.stringify([{ text: sentinel }]) } } }],
    }));

    // use-session-message-polling.ts polls every ~3s while active; give it a
    // couple of cycles plus AgentCore memory-persistence lag.
    await expect(page.getByText(sentinel)).toHaveCount(1, { timeout: 30_000 });
  });
});
