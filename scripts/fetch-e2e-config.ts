#!/usr/bin/env tsx
// Fetches the e2e config (deployed app URL + Cognito pool info) published to
// SSM by scripts/extract-deployment-info.js, and writes it to web/e2e-config.json.
//
// This lets Playwright run against an already-deployed branch (CloudFront + S3)
// without a local build or `ampx sandbox` deploy — just a fresh checkout plus
// AWS credentials with ssm:GetParameter on /outputs/*.
//
// Usage:
//   npx tsx scripts/fetch-e2e-config.ts [branch]   # branch defaults to current git branch
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'web/e2e-config.json');

// Must match the BRANCH_SLUG convention in scripts/build.sh exactly: slashes to
// dashes, lowercase; names <= 14 chars are used verbatim (identical to the
// historical slice(0,14), so already-deployed sandboxes like `main` keep their
// identifier), and only names LONGER than 14 chars get the collision-resistant
// form (first 8 chars + '-' + first 5 hex chars of the full name's sha1, 14
// total — the ampx --identifier limit is 15). A blind truncate-to-14 could
// only collide when truncation happened, i.e. for names > 14 chars (#400).
// That's the slug `pnpm deploy` published the SSM parameter under.
function slugBranch(value: string): string {
  const lowerDashed = value.replace(/\//g, '-').toLowerCase();
  if (lowerDashed.length <= 14) return lowerDashed;
  const hash = createHash('sha1').update(lowerDashed).digest('hex').slice(0, 5);
  return `${lowerDashed.slice(0, 8)}-${hash}`;
}
function slugRepo(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-/]+/g, '-');
}

const branchArg = process.argv[2];
const branch = slugBranch(
  branchArg ?? process.env.DEPLOY_BRANCH ?? execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(),
);

const repoSlug = slugRepo(
  process.env.GITHUB_REPOSITORY ??
    (() => {
      const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
      const match = remote.match(/[/:]([^/]+\/[^/]+?)(\.git)?$/);
      if (!match) throw new Error(`Could not parse repo slug from remote URL: ${remote}`);
      return match[1];
    })(),
);

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const ssmPath = `/outputs/${repoSlug}/${branch}/e2e-config`;

console.log(`Fetching e2e config from SSM: ${ssmPath} (region ${region})`);

const ssm = new SSMClient({ region });
const result = await ssm.send(new GetParameterCommand({ Name: ssmPath }));
const value = result.Parameter?.Value;
if (!value) {
  console.error(`No e2e config found at ${ssmPath}. Deploy branch "${branch}" first (pnpm deploy).`);
  process.exit(1);
}

writeFileSync(outputPath, JSON.stringify(JSON.parse(value), null, 2) + '\n');
console.log(`Wrote ${outputPath}`);
