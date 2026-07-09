import { defineFunction } from '@aws-amplify/backend';

export const mintGithubToken = defineFunction({
  name: 'mint-github-token',
  entry: './handler.ts',
  timeoutSeconds: 30,
  environment: {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? '',
    GITHUB_APP_PRIVATE_KEY_SECRET_ARN: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '',
  },
});
