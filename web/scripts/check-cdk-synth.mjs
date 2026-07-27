// Fast, credential-free CDK synth gate (issue #152).
//
// `ampx sandbox --once` can't be used here: it calls SSM:GetParameter to check
// CDK bootstrap status *before* synth runs, so it requires valid AWS credentials
// even just to reach synth (confirmed locally — see PR discussion). Instead this
// script does exactly what @aws-amplify/backend-deployer's CDKDeployer does to
// synth amplify/backend.ts (dynamically import it, then send the 'amplifySynth'
// process message that @aws-amplify/backend's createDefaultStack listens for —
// see default_stack_factory.js), without ever touching AWS.
//
// `App.synth()` alone does NOT catch circular dependencies between Amplify's
// nested stacks (e.g. `backend.createStack('foo')`) — CDK only rejects cycles
// between independent top-level stacks at synth time; nested-stack resource
// cycles are a CloudFormation deploy-time error (this is exactly the class of
// bug from PR #148: "circular dependency found between nested stacks"). So
// after synth, this script also walks every generated *.template.json and
// checks it for resource dependency cycles using the same algorithm
// aws-cdk-lib/assertions uses (Template.fromJSON throws on a cycle).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { tsImport } from 'tsx/esm/api';
import { Template } from 'aws-cdk-lib/assertions';

const outdir = mkdtempSync(path.join(tmpdir(), 'cdk-synth-check-'));

process.env.CDK_CONTEXT_JSON = JSON.stringify({
  'amplify-backend-namespace': 'synth-check',
  'amplify-backend-name': 'synth-check',
  'amplify-backend-type': 'sandbox',
});
process.env.CDK_OUTDIR = outdir;

let exitCode = 0;
try {
  await tsImport(pathToFileURL(path.resolve('amplify/backend.ts')).toString(), import.meta.url);
  // See default_stack_factory.js — the App only calls app.synth() once it
  // receives this message (mirrors how the real deployer triggers synth).
  process.emit('message', 'amplifySynth', undefined);

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
