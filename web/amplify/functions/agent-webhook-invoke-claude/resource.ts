import { defineFunction } from '@aws-amplify/backend';

// Invokes the Claude Code AgentCore Runtime (agent/default/app/ClaudeCode) for
// `@agentcore-claude` mentions. Synchronous InvokeAgentRuntime — the runtime
// clones the repo, runs the Claude Code CLI to completion, and returns its
// final text, which this Lambda reshapes into the same $.agentResult shape the
// PostFinalComment step already reads (so both agent branches converge).
export const agentWebhookInvokeClaude = defineFunction({
  name: 'agent-webhook-invoke-claude',
  entry: './handler.ts',
  // A Claude Code run can take many minutes; bound just under the state
  // machine's 15-min timeout (same budget as the harness invoke task).
  timeoutSeconds: 840,
  environment: {
    // ARN of the ClaudeCode AgentCore Runtime — populated in backend.ts.
    CLAUDE_CODE_RUNTIME_ARN: '',
  },
});
