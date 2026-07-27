import { defineFunction } from '@aws-amplify/backend';

// Kicks off the Claude Code AgentCore Runtime (agent/default/app/ClaudeCode) for
// `@agentcore-claude` mentions. Invoked via the Step Functions callback pattern
// (WAIT_FOR_TASK_TOKEN, issue #175): it hands the runtime a task token, waits
// only for the runtime's quick "job accepted" ack, and returns. The runtime runs
// the (possibly hours-long) Claude Code job in the background and resumes the
// paused SFN task itself with the $.agentResult shape PostFinalComment reads.
export const agentWebhookInvokeClaude = defineFunction({
  name: 'agent-webhook-invoke-claude',
  entry: './handler.ts',
  // Only needs to cover the InvokeAgentRuntime call + the runtime's fast ack —
  // the long-running job is no longer awaited here (the runtime calls back via
  // the task token), so this no longer needs the old 14-min budget. A minute is
  // ample; keep some headroom for cold starts and a slow runtime ack.
  timeoutSeconds: 60,
  environment: {
    // ARN of the ClaudeCode AgentCore Runtime — populated in backend.ts.
    CLAUDE_CODE_RUNTIME_ARN: '',
  },
});
