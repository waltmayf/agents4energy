import { a } from '@aws-amplify/backend';
import { mintGithubToken } from '../../functions/mint-github-token/resource';

/**
 * GitHub App token minting.
 *
 * Gets a short-lived (~1hr), repo-scoped installation access token for a
 * browser-initiated flow that needs to act on GitHub as the App. Currently
 * has no caller — see docs/github-integration.md for the GitHub App setup
 * this depends on.
 */
export const githubSchema = a.schema({
  MintGithubTokenResult: a.customType({
    token: a.string().required(),
    // ISO-8601 expiry, per GitHub's installation access token response.
    expiresAt: a.string().required(),
  }),

  mintGithubToken: a
    .mutation()
    .arguments({
      // "owner/name" — the repo the GitHub App must be installed on.
      repo: a.string().required(),
    })
    .returns(a.ref('MintGithubTokenResult'))
    .handler(a.handler.function(mintGithubToken))
    .authorization((allow) => [allow.authenticated()]),
});
