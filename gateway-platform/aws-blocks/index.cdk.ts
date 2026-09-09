import * as cdk from 'aws-cdk-lib';

import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getStackName } from '@aws-blocks/blocks/scripts';
import { addAgentCoreGateway } from './agentcore-gateway.cdk';
import { addS3ToolsGatewayTarget } from './s3-tools/gateway-target.cdk';
import { addCfdToolsGatewayTarget } from './cfd-tools/gateway-target.cdk';
import { addAthenaPySparkGatewayTarget } from './athena-pyspark/gateway-target.cdk';

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

// s3-tools gateway target (#548, 1/4 of #536) — no-ops when
// AMPLIFY_AGENT_STACK_NAME isn't set or Amplify hasn't published the Lambda
// ARN yet, so this deploy stays standalone-safe either way.
await addS3ToolsGatewayTarget(blocksStack, gateway);

// cfd-tools gateway target (#549, 2/4 of #536) — same standalone-safe no-op
// as s3-tools above; additionally no-ops when HPC isn't enabled on the
// Amplify side (see gateway-target.cdk.ts's HPC-gating doc).
await addCfdToolsGatewayTarget(blocksStack, gateway);

// athena-pyspark gateway target (#550, 3/4 of #536) — same standalone-safe
// no-op as s3-tools above.
await addAthenaPySparkGatewayTarget(blocksStack, gateway);

if (sandboxMode) {
  // Tell the runtime that cookies need cross-domain attributes (frontend on
  // localhost, API on API Gateway — different registrable domains).
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');}
