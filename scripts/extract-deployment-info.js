#!/usr/bin/env node
// Publishes the e2e config (CloudFront app URL + Cognito pool info) to SSM
// Parameter Store so `pnpm fetch:e2e-config` can run the Playwright suite
// against a deployed branch without a local `ampx sandbox` or build step.
// Everything the frontend needs (harness ARN, memory ARN, etc.) already lands
// in web/amplify_outputs.json via backend.addOutput({ custom: {...} }) — no
// post-deploy control-plane resolution needed.
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const amplifyOutputsPath = resolve(root, 'web/amplify_outputs.json');

let amplifyOutputs;
try {
  amplifyOutputs = JSON.parse(readFileSync(amplifyOutputsPath, 'utf8'));
} catch {
  console.warn(`extract-deployment-info: could not read ${amplifyOutputsPath} — skipping e2e config publish`);
  process.exit(0);
}

if (amplifyOutputs?.auth && amplifyOutputs?.custom?.hosting_domain) {
  // Prefer the branch slug the caller already computed for the S3 upload prefix
  // (BRANCH_SLUG in scripts/build.sh, BRANCH in .github/workflows/deploy.yml) —
  // these two flows use slightly different sanitizing rules, so recomputing our
  // own here could point appUrl at a different S3 prefix than what was uploaded to.
  const branch = process.env.BRANCH_SLUG ?? process.env.BRANCH ?? process.env.DEPLOY_BRANCH ??
    (() => {
      try { return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); }
      catch { return ''; }
    })().replace(/\//g, '-').toLowerCase();

  const repoSlug = (process.env.GITHUB_REPOSITORY ??
    (() => {
      try {
        const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
        const match = remote.match(/[/:]([^/]+\/[^/]+?)(\.git)?$/);
        return match?.[1] ?? '';
      } catch { return ''; }
    })()
  ).toLowerCase().replace(/[^a-z0-9-/]+/g, '-');

  if (branch && repoSlug) {
    const ssmPath = `/outputs/${repoSlug}/${branch}/e2e-config`;
    const e2eConfig = {
      appUrl: `https://${amplifyOutputs.custom.hosting_domain}/${branch}/`,
      userPoolId: amplifyOutputs.auth.user_pool_id,
      userPoolClientId: amplifyOutputs.auth.user_pool_client_id,
      region: amplifyOutputs.auth.aws_region,
      testUserEmailSsmPath: amplifyOutputs.custom.e2e_test_user_email_ssm_path,
      testUserPasswordSsmPath: amplifyOutputs.custom.e2e_test_user_password_ssm_path,
    };
    const paramPath = resolve(root, 'tmp/e2e-config.json');
    execSync(`mkdir -p ${resolve(root, 'tmp')}`, { encoding: 'utf8' });
    writeFileSync(paramPath, JSON.stringify(e2eConfig));
    try {
      execSync(
        `aws ssm put-parameter --name "${ssmPath}" --type String --overwrite --value file://${paramPath} --region ${e2eConfig.region}`,
        { encoding: 'utf8' },
      );
      console.log(`extract-deployment-info: published e2e config to SSM ${ssmPath}`);
    } catch (err) {
      console.warn('extract-deployment-info: could not publish e2e config to SSM:', err.message?.split('\n')[0]);
    }
  } else {
    console.warn('extract-deployment-info: could not determine branch/repo — skipping e2e config publish');
  }
} else {
  console.warn('extract-deployment-info: amplify_outputs.json missing auth/hosting info — skipping e2e config publish');
}
