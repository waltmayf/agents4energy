import { mintInstallationToken } from '../_shared/githubAppToken';

const GITHUB_APP_ID = process.env.GITHUB_APP_ID!;
const PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN!;

interface MintGithubTokenArgs {
  repo: string;
}

interface MintGithubTokenResult {
  token: string;
  expiresAt: string;
}

export const handler = async (
  event: { arguments: MintGithubTokenArgs },
): Promise<MintGithubTokenResult> => {
  const { repo } = event.arguments;
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`repo must be in "owner/name" form, got "${repo}"`);
  }

  return mintInstallationToken(repo, GITHUB_APP_ID, PRIVATE_KEY_SECRET_ARN);
};
