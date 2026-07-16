import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
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
// actually does programming work end-to-end:
//   - the harness clones/branches/commits/pushes and opens a real PR (#50) —
//     which requires the git/gh + node/pnpm toolchain setup to work
//   - the run takes the success path, not the caught-failure path (see below)
//   - the final assistant text carries no leaked Harmony tokens (#105)
//   - a transient Bedrock 424 doesn't fail the run (InvokeHarness Retry, #123)
//
// It runs a REAL harness turn (minutes), posts REAL comments, and opens a REAL
// PR against the target repo — so it's gated behind RUN_WEBHOOK_E2E=1 and only
// runs when the state machine ARN is present in e2e-config.json. The PR/branch
// it creates are cleaned up in a finally block. It talks to Step Functions and
// GitHub only (no browser), so it has no auth/storageState needs, but it does
// require a locally-authenticated `gh` CLI to verify + clean up the PR.

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

// The repo whose issue the harness works on. Defaults to this fork; the target
// issue (#50, "test handler git operations") exists to receive these runs.
const TARGET_REPO = process.env.WEBHOOK_E2E_REPO ?? 'waltmayf/agents4energy';
const TARGET_ISSUE = Number(process.env.WEBHOOK_E2E_ISSUE ?? '50');

// Harmony special tokens that must never survive into the final comment (#105).
const HARMONY_MARKERS = ['<|channel|>', '<|message|>', '<|start|>', '<|end|>', 'to=functions.'];

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

test.describe('agent webhook Step Function', () => {
  // Opt-in only: spends real Bedrock time, posts real comments, opens a real PR.
  test.skip(process.env.RUN_WEBHOOK_E2E !== '1', 'Set RUN_WEBHOOK_E2E=1 to run the live harness pipeline test');
  test.skip(!stateMachineArn, 'agentWebhookStateMachineArn missing from e2e-config.json — redeploy the backend');

  // A real harness turn plus git-auth setup can take several minutes.
  test.setTimeout(14 * 60_000);

  test('harness does real git work end-to-end and posts a clean (Harmony-free) reply', async () => {
    const sfn = new SFNClient({ region });
    const runId = randomUUID();
    // Unique branch/file names so the created PR is findable and this run's
    // artifacts can't collide with a concurrent/previous run's.
    const marker = runId.slice(0, 8);
    const branch = `e2e-webhook-${marker}`;
    const fileName = `e2e-webhook-${marker}.txt`;

    // Same shape agent-webhook-receiver builds for a comment-mention trigger.
    // 'comment' (not 'label') so the run also exercises the #77 label bookkeeping
    // path. The task is a tiny, self-contained change: it proves the harness can
    // actually clone/branch/commit/push/PR (the whole point of #50) while adding
    // a trivial file the test then removes. Branch name is pinned so cleanup is
    // deterministic.
    const input = {
      runId,
      source: 'github',
      trigger: 'comment',
      repo: TARGET_REPO,
      issueNumber: TARGET_ISSUE,
      issueKey: null,
      prompt:
        `This is an automated end-to-end pipeline test. On a new branch named exactly \`${branch}\`, ` +
        `add a file named \`${fileName}\` at the repo root containing the single line "e2e webhook test ${marker}", ` +
        `then commit, push, and open a pull request titled "E2E webhook test ${marker}". ` +
        `Do not modify any other files. Include the PR URL in your reply.`,
      sender: 'e2e-test',
    };

    let executionArn = '';
    try {
      const started = await sfn.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: `e2e-${TARGET_ISSUE}-${runId}`,
          input: JSON.stringify(input),
        }),
      );
      executionArn = started.executionArn!;
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
      // and InvokeHarness failures and routes them to a post-failure-comment
      // state that itself succeeds, so a caught failure still reports the
      // execution as SUCCEEDED. Distinguish the real success path (harness turn
      // ran, producing $.agentResult) from the caught-failure path ($.error
      // present) — otherwise a broken harness silently "passes".
      expect(
        parsed?.error,
        `pipeline hit its failure path (git-auth or InvokeHarness threw): ${JSON.stringify(parsed?.error)?.slice(0, 800)}`,
      ).toBeUndefined();
      expect(
        parsed?.agentResult?.Output?.Message,
        'no $.agentResult — the native InvokeHarness task did not run to completion',
      ).toBeTruthy();

      // The final decoded assistant text lives at $.agentResult.Output.Message.Content.
      // Assert no raw Harmony markup leaked through (#105).
      const contentBlocks: Array<{ Text?: string }> =
        parsed?.agentResult?.Output?.Message?.Content ?? [];
      const finalText = contentBlocks.map((b) => b?.Text ?? '').join('\n');
      for (const hm of HARMONY_MARKERS) {
        expect(finalText, `final harness text leaked Harmony marker ${hm}`).not.toContain(hm);
      }

      // The real #50 proof: a PR must exist on the branch the harness was told
      // to create. This only happens if git + gh auth, node/pnpm setup, clone,
      // commit, push, and `gh pr create` all worked in the harness session.
      const prJson = gh([
        'pr', 'list', '--repo', TARGET_REPO, '--head', branch, '--state', 'all',
        '--json', 'number,headRefName,state', '--limit', '1',
      ]);
      const prs = JSON.parse(prJson) as Array<{ number: number; headRefName: string; state: string }>;
      expect(prs.length, `harness did not open a PR on branch ${branch}`).toBeGreaterThan(0);
      expect(prs[0].headRefName).toBe(branch);
    } finally {
      // Clean up whatever the harness created so the test is repeatable and
      // leaves no artifacts. Best-effort — never fail the test on cleanup.
      try {
        const prJson = gh([
          'pr', 'list', '--repo', TARGET_REPO, '--head', branch, '--state', 'open',
          '--json', 'number', '--limit', '5',
        ]);
        for (const pr of JSON.parse(prJson) as Array<{ number: number }>) {
          gh(['pr', 'close', String(pr.number), '--repo', TARGET_REPO, '--delete-branch',
            '--comment', 'Automated cleanup: created by the e2e webhook harness pipeline test.']);
        }
      } catch {
        // Branch may not have been created (a failed run) — try a direct delete.
        try {
          gh(['api', '-X', 'DELETE', `repos/${TARGET_REPO}/git/refs/heads/${branch}`]);
        } catch {
          /* nothing to clean up */
        }
      }
    }
  });
});
