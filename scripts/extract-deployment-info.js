#!/usr/bin/env node
// Reads runtime/gateway ARNs from amplify_outputs.json (written by ampx sandbox --once)
// and/or agent/default/agentcore/.cli/deployed-state.json (legacy agentcore deploy),
// then writes web/deployment-info.json so the frontend can import ARNs at build time.
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployedStatePath = resolve(root, 'agent/default/agentcore/.cli/deployed-state.json');
const outputPath = resolve(root, 'web/deployment-info.json');

let deployedState;
try {
  deployedState = JSON.parse(readFileSync(deployedStatePath, 'utf8'));
} catch {
  // Not fatal — the runtime may now be managed by the Amplify agentStack
  console.warn(`extract-deployment-info: no deployed-state.json found at ${deployedStatePath} — will use amplify_outputs.json`);
  deployedState = { targets: {} };
}

const targets = deployedState?.targets ?? {};
const targetName = Object.keys(targets)[0];
const resources = targets[targetName]?.resources ?? {};

const memories = {};
for (const [name, m] of Object.entries(resources.memories ?? {})) {
  memories[name] = { memoryId: m.memoryId, memoryArn: m.memoryArn };
}

// Derive region from the stack name or fall back to the first memory ARN.
const firstMemoryArn = Object.values(memories)[0]?.memoryArn ?? '';
const region = firstMemoryArn.split(':')[3] || 'us-east-1';

// Resolve harness ARNs from the Harness control-plane API.
// The Harness API endpoint is bedrock-agentcore-control.{region}.amazonaws.com/harnesses
// (uses SigV4 with service name "bedrock-agentcore", not "bedrock-agentcore-control").
// Naming convention: <target>_<HarnessName>-<suffix>  e.g. default_MyHarness-PXjJuBIMNs
const harnesses = {};
let harnessListRaw;
try {
  // aws-curl-style request via Python botocore for SigV4 signing
  harnessListRaw = execSync(
    `python3 -c "
import boto3, json, urllib.request, urllib.error
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
creds = boto3.Session().get_credentials().get_frozen_credentials()
req = AWSRequest(method='GET', url='https://bedrock-agentcore-control.${region}.amazonaws.com/harnesses')
SigV4Auth(creds, 'bedrock-agentcore', '${region}').add_auth(req)
r = urllib.request.Request(req.url, headers=dict(req.headers), method='GET')
with urllib.request.urlopen(r) as resp:
    print(resp.read().decode())
"`,
    { encoding: 'utf8' }
  );
} catch (err) {
  console.warn('extract-deployment-info: could not list harnesses:', err.message);
}
if (harnessListRaw) {
  const harnessPrefix = `${targetName}_`;
  for (const h of JSON.parse(harnessListRaw)?.harnesses ?? []) {
    if (h.harnessName.startsWith(harnessPrefix)) {
      const logicalName = h.harnessName.slice(harnessPrefix.length);
      harnesses[logicalName] = { harnessArn: h.arn };
    }
  }
}

// Read gateway outputs from CloudFormation via AWS CLI (avoids SDK dependency in plain Node)
let gateway = null;
if (resources.stackName) {
  try {
    const raw = execSync(
      `aws cloudformation describe-stacks --stack-name ${resources.stackName} --region ${region} --query "Stacks[0].Outputs" --output json`,
      { encoding: 'utf8' }
    );
    const outputs = JSON.parse(raw) ?? [];
    const get = (key) => outputs.find(o => o.OutputKey === key)?.OutputValue;
    const gatewayArn = get('UserMcpGatewayArn');
    const gatewayId = get('UserMcpGatewayId');
    const gatewayEndpoint = get('UserMcpGatewayEndpoint');
    if (gatewayArn) {
      gateway = { gatewayArn, gatewayId, gatewayEndpoint };
    }
  } catch (err) {
    console.warn('extract-deployment-info: could not read CFN outputs:', err.message);
  }
}

// Resolve runtime ARNs from the AgentCore control-plane API.
// Naming convention: <target>_<RuntimeName>-<suffix>  e.g. default_MyHarness-abc123
const runtimes = {};
// First, try to read from deployed-state.json directly (fastest, no API call needed)
for (const [name, r] of Object.entries(resources.runtimes ?? {})) {
  runtimes[name] = { runtimeArn: r.runtimeArn, roleArn: r.roleArn };
}
// If deployed-state.json didn't have runtimes, fall back to AWS CLI
if (Object.keys(runtimes).length === 0) {
  let runtimeListRaw;
  try {
    runtimeListRaw = execSync(
      `aws bedrock-agentcore-control list-agent-runtimes --region ${region} --output json`,
      { encoding: 'utf8' }
    );
  } catch (err) {
    console.warn('extract-deployment-info: could not list runtimes:', err.message);
  }
  if (runtimeListRaw) {
    const runtimePrefix = `${targetName}_`;
    for (const r of JSON.parse(runtimeListRaw)?.agentRuntimes ?? []) {
      if (r.agentRuntimeName?.startsWith(runtimePrefix)) {
        const logicalName = r.agentRuntimeName.slice(runtimePrefix.length).replace(/-[^-]+$/, '');
        runtimes[logicalName] = { runtimeArn: r.agentRuntimeArn };
      }
    }
  }
}

const amplifyOutputsPath = resolve(root, 'web/amplify_outputs.json');
let amplifyOutputs;
try {
  amplifyOutputs = JSON.parse(readFileSync(amplifyOutputsPath, 'utf8'));
} catch {
  console.warn('extract-deployment-info: could not read amplify_outputs.json');
}

// Resolve the AppSync API ID by reading the sidecar or listing APIs.
let outerAppsyncApiId = '';
if (amplifyOutputs) {
  const sidecarPath2 = resolve(root, 'web/amplify-table-suffix.txt');
  try {
    outerAppsyncApiId = readFileSync(sidecarPath2, 'utf8').trim();
  } catch {
    const appsyncUrl = amplifyOutputs?.data?.url ?? '';
    const appsyncRegion2 = amplifyOutputs?.data?.aws_region ?? region;
    try {
      const cfnApiRaw = execSync(`aws appsync list-graphql-apis --region ${appsyncRegion2} --output json`, { encoding: 'utf8' });
      const apis = JSON.parse(cfnApiRaw)?.graphqlApis ?? [];
      const match = apis.find(a => a.uris?.GRAPHQL === appsyncUrl);
      outerAppsyncApiId = match?.apiId ?? '';
    } catch { /* ignore */ }
  }
}

const appsync = amplifyOutputs ? {
  endpoint: amplifyOutputs?.data?.url ?? '',
  apiId: outerAppsyncApiId,
  region: amplifyOutputs?.data?.aws_region ?? region,
} : undefined;

const info = {
  target: targetName,
  region,
  harnesses,
  memories,
  runtimes,
  ...(gateway ? { gateway } : {}),
  ...(appsync ? { appsync } : {}),
};
writeFileSync(outputPath, JSON.stringify(info, null, 2) + '\n');
console.log(`extract-deployment-info: wrote ${outputPath}`);
console.log(JSON.stringify(info, null, 2));
