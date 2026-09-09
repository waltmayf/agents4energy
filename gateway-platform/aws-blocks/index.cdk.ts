import * as cdk from 'aws-cdk-lib';

import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';
import { addAgentCoreGateway } from './agentcore-gateway.cdk';
import { addS3ToolsGatewayTarget } from './gateway-targets/s3Tools.cdk';
import { addGraphTraverseGatewayTarget } from './gateway-targets/graphTraverse.cdk';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = getStackName({ sandbox: sandboxMode, projectRoot });
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});

// The real AgentCore Gateway + CUSTOM_JWT authorizer (#535) — replaces the
// #534 scaffold's PENDING_GATEWAY_OUTPUTS SSM stub with real values.
const { gateway } = addAgentCoreGateway(blocksStack, stackName);

// Lambda-backed gateway tool targets (#536) — moved in from Amplify's
// web/amplify/constructs/*GatewayTarget + backend.ts. Each is independently
// gated on its own Amplify-published SSM dependency being resolvable (see
// each target's own addXGatewayTarget for details), so this app still synths
// and deploys standalone when Amplify hasn't been deployed yet.
await addS3ToolsGatewayTarget(blocksStack, gateway);
await addGraphTraverseGatewayTarget(blocksStack, gateway);

if (sandboxMode) {
  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');}
