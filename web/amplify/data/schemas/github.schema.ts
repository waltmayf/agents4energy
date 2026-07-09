import { a } from '@aws-amplify/backend';
import { mintGithubToken } from '../../functions/mint-github-token/resource';

/**
 * GitHub App token minting.
 *
 * Replaces long-lived PAT usage for browser-initiated sessions: the browser
 * calls mintGithubToken(repo) to get a short-lived (~1hr), repo-scoped
 * installation access token, then passes it as `githubToken` on
 * invokeHandler. See docs/github-integration.md for the GitHub App setup
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
