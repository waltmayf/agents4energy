import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';

// End-to-end verification of the AgentCore harness webhook pipeline (issue #50,
// milestone "Reliable agent harness for programming work"). Instead of faking a
// GitHub webhook delivery, this drives the Step Function directly with the same
// input shape agent-webhook-receiver produces, then asserts the whole pipeline
// (post-initial-comment → git-auth prep → native InvokeHarness → post-final-comment)
// reaches SUCCEEDED and that the retry/sanitization hardening on the branch holds:
//   - a transient Bedrock 424 no longer fails the run (InvokeHarness Retry, #123)
//   - the final assistant text carries no leaked Harmony tokens (#105)
//
// It runs a REAL harness turn (minutes) and posts REAL comments to the target
// GitHub issue, so it's gated behind RUN_WEBHOOK_E2E=1 and only runs when the
// state machine ARN is present in e2e-config.json. It does not depend on the
// browser, so it has no auth/storageState needs.

const root = resolve(__dirname, '../..');
const e2eConfigPath = resolve(root, 'web/e2e-config.json');
const cfg = existsSync(e2eConfigPath)
  ? (JSON.parse(readFileSync(e2eConfigPath, 'utf8')) as {
      region?: string;
      agentWebhookStateMachineArn?: string;
    })
  : null;

const stateMachineArn = cfg?.agentWebhookStateMachineArn;
const region = cfg?.region ?? process.env.AWS_REGION ?? 'us-east-1';

// The repo whose issue the harness will comment on. Defaults to this fork; the
// target issue (#50, "test handler git operations") exists to receive these runs.
const TARGET_REPO = process.env.WEBHOOK_E2E_REPO ?? 'waltmayf/agents4energy';
const TARGET_ISSUE = Number(process.env.WEBHOOK_E2E_ISSUE ?? '50');

// Harmony special tokens that must never survive into the final comment (#105).
const HARMONY_MARKERS = ['<|channel|>', '<|message|>', '<|start|>', '<|end|>', 'to=functions.'];

test.describe('agent webhook Step Function', () => {
  // Opt-in only: this spends real Bedrock time and posts real GitHub comments.
  test.skip(process.env.RUN_WEBHOOK_E2E !== '1', 'Set RUN_WEBHOOK_E2E=1 to run the live harness pipeline test');
  test.skip(!stateMachineArn, 'agentWebhookStateMachineArn missing from e2e-config.json — redeploy the backend');

  // A real harness turn plus git-auth setup can take several minutes.
  test.setTimeout(14 * 60_000);

  test('invokes the harness end-to-end and posts a clean (Harmony-free) reply', async () => {
    const sfn = new SFNClient({ region });
    const runId = randomUUID();

    // Same shape agent-webhook-receiver builds for a comment-mention trigger.
    // 'comment' (not 'label') so the run also exercises the #77 label bookkeeping
    // path without depending on the agentcore label being toggled. The prompt is
    // read-only on purpose — it asks the agent to report, not to open a PR — so
    // the test is idempotent and safe to re-run.
    const input = {
      runId,
      source: 'github',
      trigger: 'comment',
      repo: TARGET_REPO,
      issueNumber: TARGET_ISSUE,
      issueKey: null,
      prompt:
        'This is an automated end-to-end pipeline test. In one short sentence, ' +
        'confirm you received this request and can see the repository context. ' +
        'Do not make any code changes, commits, or pull requests.',
      sender: 'e2e-test',
    };

    const started = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: `e2e-${TARGET_ISSUE}-${runId}`,
        input: JSON.stringify(input),
      }),
    );
    const executionArn = started.executionArn!;
    expect(executionArn).toBeTruthy();

    // Poll to completion.
    let status = 'RUNNING';
    let output: string | undefined;
    const deadline = Date.now() + 13 * 60_000;
    while (status === 'RUNNING' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10_000));
      const desc = await sfn.send(new DescribeExecutionCommand({ executionArn }));
      status = desc.status ?? 'RUNNING';
      output = desc.output;
    }

    expect(status, `execution ${executionArn} did not succeed (output: ${output ?? 'none'})`).toBe('SUCCEEDED');

    const parsed = output ? JSON.parse(output) : {};

    // A SUCCEEDED status is NOT sufficient: the pipeline catches git-auth-prep
    // and InvokeHarness failures and routes them to a post-failure-comment state
    // that itself succeeds, so a caught failure still reports the execution as
    // SUCCEEDED. Distinguish the real success path (harness turn ran, producing
    // $.agentResult) from the caught-failure path ($.error present, no
    // $.agentResult) — otherwise a broken harness silently "passes".
    expect(
      parsed?.error,
      `pipeline hit its failure path (git-auth or InvokeHarness threw): ${JSON.stringify(parsed?.error)?.slice(0, 600)}`,
    ).toBeUndefined();
    expect(
      parsed?.agentResult?.Output?.Message,
      'no $.agentResult — the native InvokeHarness task did not run to completion',
    ).toBeTruthy();

    // The final decoded assistant text lives at $.agentResult.Output.Message.Content.
    // Assert the harness produced content and that no raw Harmony markup leaked
    // through — post-comment sanitizes it, and the invoke result feeding it
    // should read as clean natural language.
    const contentBlocks: Array<{ Text?: string }> =
      parsed?.agentResult?.Output?.Message?.Content ?? [];
    const finalText = contentBlocks.map((b) => b?.Text ?? '').join('\n');

    for (const marker of HARMONY_MARKERS) {
      expect(finalText, `final harness text leaked Harmony marker ${marker}`).not.toContain(marker);
    }
  });
});
