/**
 * Cognito groups defined in `web/amplify/auth/resource.ts`. There is no
 * inexpensive way to list Cognito user pool groups from the browser (it
 * requires an admin-scoped Lambda), so this list is kept in sync by hand —
 * update both places together when adding/removing a group.
 *
 * `service-webhook` (#340) is the reserved machine-identity group for the
 * `@agentcore-claude` webhook — it's listed here (not filtered out) so an
 * admin can grant it least-privilege MCP tools through this same
 * permissions-panel UI, same as any human group.
 */
export const COGNITO_GROUPS = ['admin', 'reservoir-eng', 'drilling', 'service-webhook'] as const;

export type CognitoGroup = (typeof COGNITO_GROUPS)[number];
