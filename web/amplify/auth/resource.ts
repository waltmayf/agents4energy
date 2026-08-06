import { defineAuth } from '@aws-amplify/backend';

/**
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */
// Foundational identity groups for per-user MCP tool governance (#245/#246).
// The actual group -> tool permission mapping is #247's job; this issue just
// establishes the groups so `cognito:groups` is populated on user tokens.
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  groups: ['admin', 'reservoir-eng', 'drilling'],
});
