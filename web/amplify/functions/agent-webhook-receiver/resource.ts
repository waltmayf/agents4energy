import { defineFunction, secret } from '@aws-amplify/backend';

export const agentWebhookReceiver = defineFunction({
  name: 'agent-webhook-receiver',
  entry: './handler.ts',
  timeoutSeconds: 10,
  environment: {
    // GitHub webhook HMAC secret — sourced via Amplify's secret() (SSM
    // SecureString) rather than a deploy-time ARN env var, so a bare local
    // `ampx sandbox` deploy can't silently wipe it (see issue #239). Amplify
    // resolves the value into this env var at deploy and grants the function
    // read access automatically — the handler reads the value directly, with
    // no runtime Secrets Manager call. Set once with:
    //   npx ampx sandbox secret set GITHUB_WEBHOOK_SECRET   (local)
    // or in the Amplify console (branch/shared) for CI deploys.
    GITHUB_WEBHOOK_SECRET: secret('GITHUB_WEBHOOK_SECRET'),
    // Jira is optional (many branches never use it), and secret() fails the
    // whole deploy when unset — so Jira's shared secret stays on the
    // deploy-time ARN pattern, wired conditionally in backend.ts. Empty when
    // Jira isn't configured on this branch.
    JIRA_WEBHOOK_SECRET_ARN: process.env.JIRA_WEBHOOK_SECRET_ARN ?? '',
    STATE_MACHINE_ARN: '',
    CLAUDE_CODE_RUNTIME_ARN: '',
  },
});
