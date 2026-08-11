import { defineAuth } from '@aws-amplify/backend';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
// Foundational identity groups for per-user MCP tool governance (#245/#246).
// The actual group -> tool permission mapping is #247's job; this issue just
// establishes the groups so `cognito:groups` is populated on user tokens.
//
// `service-webhook` (#340) is a reserved machine-identity group, not a human
// one — it's assigned to the dedicated Cognito user the `@agentcore-claude`
// webhook authenticates as (see the ServiceWebhook construct in backend.ts),
// so its tool access is governed by the same GroupToolGrant/Cedar machinery
// as any human group, just scoped to what automation needs.
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['admin', 'reservoir-eng', 'drilling', 'service-webhook'],
});
