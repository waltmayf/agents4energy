// Credential-free CDK synth gate for gateway-platform/ (the analog of
// web/scripts/check-cdk-synth.mjs — see AGENTS.md "GitHub Pull Requests").
//
// Unlike web/'s Amplify backend, this is a plain `cdk.App` (aws-blocks/index.cdk.ts)
// with two independent top-level stacks (the Blocks backend stack + the SSM
// gateway-outputs stub stack) — no nested-stack cycle risk yet, but this gate
// still walks every synthesized *.template.json with aws-cdk-lib/assertions'
// Template.fromJSON (which runs the same cyclic-dependency check CDK uses)
// so the check stays meaningful once #535 adds real AgentCore CDK constructs.
//
// Two environment gotchas carried over from spike #533 (see FINDINGS.md and
// this app's README):
//   - `--conditions=cdk` must be set via NODE_OPTIONS, or Building Blocks
//     silently loads mock implementations instead of real CDK constructs.
//   - `AWS_EC2_METADATA_DISABLED=false` avoids a red herring "Unable to
//     resolve AWS account to use" error under non-EC2 container credential
//     sources — not needed for `synth` (no AWS calls happen), but set here
//     for parity with `npm run sandbox`/`deploy` so this script's env matches
//     what a real deploy uses.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';

const outdir = mkdtempSync(path.join(tmpdir(), 'gateway-platform-synth-check-'));

let exitCode = 0;
try {
  execFileSync(
    'npx',
    [
      'cdk',
      'synth',
      '--context',
      'sandboxMode=true',
      '--app',
      'npx tsx aws-blocks/index.cdk.ts',
      '--output',
      outdir,
      '--quiet',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        NODE_OPTIONS: '--conditions=cdk',
        AWS_EC2_METADATA_DISABLED: 'false',
        CDK_DEFAULT_ACCOUNT: process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
        CDK_DEFAULT_REGION: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
      },
      stdio: 'inherit',
    }
  );

  const templateFiles = readdirSync(outdir).filter((f) => f.endsWith('.template.json'));
  if (templateFiles.length === 0) {
    throw new Error(`No CloudFormation templates found in ${outdir} after synth`);
  }

  for (const file of templateFiles) {
    const template = JSON.parse(readFileSync(path.join(outdir, file), 'utf8'));
    // Template.fromJSON runs aws-cdk-lib's own cyclic-dependency check
    // (checkTemplateForCyclicDependencies) and throws AssertionError on a cycle.
    Template.fromJSON(template);
  }

  console.log(`CDK synth OK — checked ${templateFiles.length} template(s) for dependency cycles.`);
} catch (error) {
  console.error('CDK synth check failed:');
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}

process.exit(exitCode);
