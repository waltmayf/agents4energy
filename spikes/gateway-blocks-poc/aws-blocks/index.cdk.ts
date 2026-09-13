import * as cdk from 'aws-cdk-lib';

import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';
import { addGatewayExperimentStack } from './gateway-experiment.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

// Spike #533 only — gated so it never runs during normal `npm run dev` /
// `npm run sandbox` use of this scaffold.
if (process.env.AGENTCORE_GATEWAY_EXPERIMENT === '1') {
  addGatewayExperimentStack(app);
}

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});

if (sandboxMode) {
  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');}
