import { defineFunction } from '@aws-amplify/backend';

// Kicks off the Claude Code AgentCore Runtime (web/amplify/agentcore/ClaudeCode) for
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
    // Service-webhook machine identity (#340) — populated in backend.ts.
    // Lets this Lambda mint a fresh Cognito access token for the dedicated
    // `service-webhook` group user and relay it to the runtime as
    // `cognitoAccessToken`, so the run's gateway-routed MCP tools are
    // authorized by Cedar against that group instead of bypassing it.
    SERVICE_WEBHOOK_USER_POOL_CLIENT_ID: '',
    SERVICE_WEBHOOK_EMAIL_SSM_PATH: '',
    SERVICE_WEBHOOK_PASSWORD_SSM_PATH: '',
    // GitHub App credentials (issue #444) — lets this Lambda mint a fresh
    // installation token at invoke time instead of relying on the ~1h token
    // threaded from PostInitialComment, which goes stale across monitor-loop
    // re-invokes. Populated in backend.ts; empty on branches without the App
    // configured, in which case the handler falls back to the threaded token.
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '',
  },
});
