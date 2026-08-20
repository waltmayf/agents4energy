import { defineFunction } from '@aws-amplify/backend';

// Monitor-loop check step (issue #262, part of #260). When an @agentcore-claude
// run ends in `agentStatus: 'monitoring'` (sub-issue 1, #261/#267), the webhook
// state machine enters a Wait → RunMonitorCheck → Choice loop. This Lambda IS
// the RunMonitorCheck step: it runs the monitor spec's `checkCommand` in the
// SAME ClaudeCode runtime session as the original run (so /mnt/workspace +
// memory continuity hold) via InvokeAgentRuntimeCommand, and reports whether the
// condition is met (exitCode === 0).
//
// Mirrors agent-webhook-invoke-claude's env/timeout shape — it too takes the
// ClaudeCode runtime ARN (an agent-stack token the function stack already
// depends on), so wiring it as a defineFunction introduces no new cross-stack
// cycle. Kept short: a single exec + stream drain, not the long agent turn.
export const agentWebhookMonitorCheck = defineFunction({
  name: 'agent-webhook-monitor-check',
  entry: './handler.ts',
  timeoutSeconds: 120,
  environment: {
    // ARN of the ClaudeCode AgentCore Runtime — populated in backend.ts.
    CLAUDE_CODE_RUNTIME_ARN: '',
    // Deploy-time inputs read directly from process.env at synth (same pattern
    // as agent-webhook-invoke-claude/resource.ts and mint-github-token/resource.ts)
    // — used to mint a fresh installation token before running checkCommand so a
    // long wait between waves doesn't leave ~/.git-credentials stale (issue #467).
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '',
  },
});
