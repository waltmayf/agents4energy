import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { listSessionMessages } from './functions/list-session-messages/resource';
import { updateSessionSummary } from './functions/update-session-summary/resource';
import { registerMcpTarget } from './functions/register-mcp-target/resource';
import { listMcpTools } from './functions/list-mcp-tools/resource';
import { invokeAgent } from './functions/invoke-agent/resource';
import { mintGithubToken } from './functions/mint-github-token/resource';
import { agentWebhookReceiver } from './functions/agent-webhook-receiver/resource';
import { agentWebhookPostComment } from './functions/agent-webhook-post-comment/resource';
import { agentWebhookInvokeAgent } from './functions/agent-webhook-invoke-agent/resource';
import { agentWebhookInvokeClaude } from './functions/agent-webhook-invoke-claude/resource';
import { agentWebhookAuthorizer } from './functions/agent-webhook-authorizer/resource';
import { s3Tools } from './functions/s3-tools/resource';
import { agentWorkspace } from './storage/resource';
import { Policy, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Fn, Stack, CfnOutput } from 'aws-cdk-lib';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import { HostingConstruct } from './constructs/hostingConstruct';
import { AgentCoreApplication, type HarnessDeployment } from './constructs/agentCoreApplication';
import type { HarnessSpec } from '@aws/agentcore-cdk';
import { E2eTestUser } from './constructs/e2eTestUser/resource';
import { AgentWebhookStack } from './constructs/agentWebhookStack';
import { S3ToolsGatewayTarget } from './constructs/s3ToolsGatewayTarget/resource';
import { S3ToolsMcpServerSeed } from './constructs/s3ToolsMcpServerSeed/resource';

import { StringParameter } from 'aws-cdk-lib/aws-ssm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// AGENTCORE CONFIG — memories/gateways read from agentcore.json at synth time
// (same file the `agentcore` CLI reads/writes; the CLI remains usable for local
// iteration via `agentcore dev`/`agentcore validate`, but production deploys no
// longer run `agentcore deploy` — this stack owns the resources directly).
//
// Harnesses are inlined below as literal `HarnessSpec`s (the `harness.json`
// shape @aws/agentcore-cdk validates) instead of living in agentcore.json, so
// the system prompt + Cognito authorizer can be injected at synth time.
// ============================================================================

const agentcoreRoot = resolve(__dirname, '../../agent/default/agentcore');
const projectSpec = JSON.parse(readFileSync(resolve(agentcoreRoot, 'agentcore.json'), 'utf8'));

// MyHarness — see agent/default/app/MyHarness/. The system prompt is prose, not
// config, so it lives in system-prompt.md and is read from disk here; everything
// else is inlined below as a literal `HarnessSpec` (the shape @aws/agentcore-cdk
// validates and turns into the AWS::BedrockAgentCore::Harness resource).
const myHarnessSystemPrompt = readFileSync(
  resolve(agentcoreRoot, '../app/MyHarness/system-prompt.md'),
  'utf8',
).trim();

const harnessSpecs: HarnessSpec[] = [
  {
    name: 'MyHarness',
    // provider+modelId+apiFormat — the HarnessModelSchema shape. We use the
    // Bedrock Converse API (`converse_stream`), NOT the OpenAI-compatible
    // `chat_completions` path. The latter routes through Bedrock's OpenAI-compat
    // gateway, which returns a hard `404 not_found_error` ("The model
    // 'openai.gpt-oss-120b-1:0' does not exist") for this model even though the
    // exact same id succeeds via Converse and via `bedrock:InvokeModel` — every
    // harness invoke failed this way from the 2026-07-27 migration deploy until
    // this switch. Converse is the supported path for the gpt-oss model here.
    model: {
      provider: 'bedrock',
      modelId: 'openai.gpt-oss-120b-1:0',
      apiFormat: 'converse_stream',
    },
    systemPrompt: myHarnessSystemPrompt,
    tools: [
      { type: 'agentcore_browser', name: 'browser', config: { agentCoreBrowser: {} } },
      // The agentcore_code_interpreter sandbox was intentionally removed (#191):
      // it ran the model's shell commands in an isolated environment separate
      // from the harness runtime session that the webhook git-auth step seeds,
      // causing the split-brain in #190. With it gone, the agent runs shell
      // commands in the harness runtime session, so seeded git/gh credentials
      // and installed CLIs are exactly what the agent sees.
    ],
    // No Claude Code-style skills on MyHarness. `HarnessSpec` is the schema's
    // *output* type (skills defaults to []), so the field is required here.
    skills: [],
    // Reference the same-project MyHarnessMemory created from agentcore.json's
    // `memories`. `mode: 'existing'` + name → the construct wires the memory's
    // discovery env vars + IAM onto this harness's execution role.
    memory: { mode: 'existing', name: 'MyHarnessMemory' },
    truncation: {
      strategy: 'summarization',
      config: { summarization: {} },
    },
    // authorizerConfiguration is re-derived from this stack's own Cognito user
    // pool below (see harnessSpecsWithAuth) rather than hardcoded here — a
    // fixed discoveryUrl/allowedClients would go stale across deployments.
  },
];

// Physical gateway names are account+region unique in Bedrock AgentCore, so a
// fixed name in agentcore.json collides across sandboxes/branches deployed to
// the same account (see PR #30 review — "AlreadyExists" against a stale
// AgentCore-default-default stack). Suffix with the Amplify backend
// namespace+name (same CDK context keys the `ampx` deployer injects — see
// @aws-amplify/platform-core's CDKContextKey) so every sandbox/branch gets a
// distinct physical gateway name without hand-managed identifiers.
const sanitizeForResourceName = (value: string) =>
  value.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

const toGatewayResourceName = (...segments: string[]) =>
  sanitizeForResourceName(segments.filter(Boolean).join('-'))
    .slice(0, 100)
    .replace(/-$/, '');

// Harness/Memory physical names don't have a `resourceName` escape hatch like
// the Gateway does — @aws/agentcore-cdk's BasePrimitiveConstruct always derives
// them as `${projectName}_${name}`, and `projectName` is the fixed "default"
// from agentcore.json. Make the *projectName* itself unique per deployment so
// harness role name / CfnMemory name / CfnHarness name stop colliding with the
// legacy AgentCore-default-default stack (or with each other across sandboxes).
// Harness/Memory names are constrained by the AgentCore API to
// ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ (max 48 chars, alnum+underscore only) — tighter
// than the gateway's hyphen-friendly name, so no hyphens here and the combined
// "<projectName>_<resourceName>" must fit in 48 chars.
const sanitizeForAgentCoreName = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '');

const toAgentCoreProjectName = (maxLength: number, ...segments: string[]) =>
  segments
    .filter(Boolean)
    .map(sanitizeForAgentCoreName)
    .filter(Boolean)
    .join('_')
    .slice(0, maxLength);

const backend = defineBackend({
  auth,
  data,
  listSessionMessages,
  updateSessionSummary,
  registerMcpTarget,
  listMcpTools,
  invokeAgent,
  mintGithubToken,
  agentWebhookReceiver,
  agentWebhookPostComment,
  agentWebhookInvokeAgent,
  agentWebhookInvokeClaude,
  agentWebhookAuthorizer,
  s3Tools,
  agentWorkspace,
});

backend.stack.tags.setTag('Project', 'workshop');
backend.stack.tags.setTag('RootStack', backend.stack.stackName);

// `ampx` (sandbox and pipeline-deploy) injects these CDK context values before
// synth — see @aws-amplify/platform-core's CDKContextKey (amplify-backend-namespace/
// -name). namespace is the app id (or local package name for sandboxes); name is the
// branch (or sandbox identifier, e.g. the BRANCH_SLUG scripts/build.sh passes via
// `ampx sandbox --identifier`). Concatenating them gives every deployment — each
// branch, each developer's sandbox — its own physical gateway name.
const backendNamespace = backend.stack.node.tryGetContext('amplify-backend-namespace') as string | undefined;
const backendName = backend.stack.node.tryGetContext('amplify-backend-name') as string | undefined;

// ============================================================================
// HOSTING STACK — S3 + CloudFront static website hosting
// ============================================================================

const hostingStack = backend.createStack('hosting');
const hosting = new HostingConstruct(hostingStack, 'Hosting');

// ============================================================================
// AGENT STACK — AgentCore Runtime, Memory, Harness, Gateway
// ============================================================================

const agentStack = backend.createStack('agent');

// Cognito discovery URL: https://cognito-idp.{region}.amazonaws.com/{userPoolId}
const userPoolId = backend.auth.resources.userPool.userPoolId;
const cognitoDiscoveryUrl = Fn.join('', [
  'https://cognito-idp.',
  Stack.of(backend.auth.resources.userPool).region,
  '.amazonaws.com/',
  userPoolId,
  '/.well-known/openid-configuration',
]);

// MyHarness authorizes with AWS_IAM (SigV4), not CUSTOM_JWT: omitting
// `authorizerConfiguration` makes a CfnHarness default to IAM auth. Every
// caller (the browser transport, the invoke-agent + webhook Lambdas, and
// scripts/invoke.ts) now invokes it via the SDK's InvokeHarnessCommand with
// SigV4-signed credentials rather than a Cognito Bearer JWT. This lets the
// webhook path use the native InvokeHarness / InvokeAgentRuntimeCommand SDK
// operations (which are SigV4-only) — deleting the hand-rolled event-stream
// decoder and resolving the long-stream `TypeError: terminated` (#57), since
// the SDK owns connection timeouts and retries. Browser callers sign with
// Cognito Identity Pool credentials (the pool's authenticated role is granted
// both bedrock-agentcore:InvokeAgentRuntime and :InvokeHarness in the wiring
// below — InvokeHarnessCommand's IAM authorization checks both actions).
// Wrap each spec as a HarnessDeployment for the construct. `harnessDir` points
// at agent/default/app/MyHarness/ so the construct can auto-discover a
// system-prompt.md there if `spec.systemPrompt` is ever omitted (we pass it
// literally above, so this is belt-and-braces). No Cognito authorizer is
// injected — MyHarness authorizes with AWS_IAM (see the comment above), so
// `authorizerType`/`authorizerConfiguration` stay unset and default to IAM.
// AGENTCORE_SKIP_HARNESS=1 deploys everything EXCEPT the harness. Used for a
// one-time two-phase migration: the harness execution role has a *fixed*
// physical name (`<projectName>_MyHarness`), so when the construct tree changes
// (e.g. swapping to the real AgentCoreApplication) its logical ID changes while
// the name stays — and CloudFormation's create-before-delete on an in-place
// update collides on that name ("already exists"). Deploy once with the flag to
// let CFN delete the old fixed-name role, then again without it to recreate it
// under the new logical ID with the now-free name. Not needed on fresh stacks.
const skipHarness = process.env.AGENTCORE_SKIP_HARNESS === '1';
const harnessSpecsWithAuth: HarnessDeployment[] = (skipHarness ? [] : harnessSpecs).map((spec) => ({
  spec,
  harnessDir: resolve(agentcoreRoot, '../app/MyHarness'),
}));

// Memory/Harness/Gateway from agentcore.json — same-stack CDK tokens, no
// post-deploy control-plane resolution needed. agentcore.json's `runtimes` is
// empty: the AgUiHandler runtime was retired (#33) and MyHarness is the sole
// runtime.
//
// `name` in agentcore.json is just the logical/config name — the physical
// CfnGateway name comes from `resourceName` when set (see Gateway.js in
// @aws/agentcore-cdk). Override it per-deployment so concurrent sandboxes/
// branches in the same account don't collide on physical gateway names.
const agentCoreGatewaysWithUniqueNames = projectSpec.agentCoreGateways?.length
  ? projectSpec.agentCoreGateways.map((gateway: { name: string; [key: string]: unknown }) => ({
      ...gateway,
      resourceName: toGatewayResourceName(projectSpec.name, gateway.name, backendNamespace ?? '', backendName ?? ''),
      // Re-derive the CUSTOM_JWT authorizer from THIS stack's own Cognito user
      // pool, the same way the harness authorizer is (see harnessSpecs comment
      // above). agentcore.json pins a discoveryUrl/allowedClients to a specific
      // pool id from whenever it was generated; on `main` the gateway already
      // exists so CloudFormation never re-reads them, but every fresh
      // branch/sandbox creates a NEW gateway pointing at that now-deleted pool,
      // whose discovery document 404s → "failed to fetch discovery document …
      // Status Code: 400" → NotStabilized → the whole agent stack rolls back
      // (#128). Pointing it at the live pool fixes it for good.
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: cognitoDiscoveryUrl,
          allowedClients: [backend.auth.resources.userPoolClient.userPoolClientId],
        },
      },
    }))
  : undefined;

// Harness/Memory physical names are `${projectName}_${name}`, capped at 48 chars
// total (alnum+underscore only). Reserve enough room for the longest configured
// harness/memory logical name plus the joining underscore, then fit the unique
// projectName into whatever's left.
const longestResourceNameLength = Math.max(
  1,
  ...harnessSpecs.map((h) => h.name.length),
  ...(projectSpec.memories ?? []).map((m: { name: string }) => m.name.length),
  // Runtimes (e.g. ClaudeCode) share the same `${projectName}_${name}` naming
  // and 48-char cap as harnesses/memories.
  ...(projectSpec.runtimes ?? []).map((r: { name: string }) => r.name.length),
);
const uniqueProjectName = toAgentCoreProjectName(
  48 - 1 - longestResourceNameLength,
  projectSpec.name,
  backendNamespace ?? '',
  backendName ?? '',
);

const agentCoreApp = new AgentCoreApplication(agentStack, 'AgentCoreApplication', {
  projectName: uniqueProjectName,
  memories: projectSpec.memories ?? [],
  // AgentCore Runtimes from agentcore.json — the ClaudeCode container agent
  // (invoked via @agentcore-claude on GitHub issues/PRs, see agent/default/app/
  // ClaudeCode). Built via CodeBuild → ECR → CfnRuntime by @aws/agentcore-cdk.
  runtimes: projectSpec.runtimes ?? [],
  harnesses: harnessSpecsWithAuth,
  mcpSpec: agentCoreGatewaysWithUniqueNames
    ? {
        agentCoreGateways: agentCoreGatewaysWithUniqueNames,
        mcpRuntimeTools: projectSpec.mcpRuntimeTools,
      }
    : undefined,
});

// @aws/agentcore-cdk stamps every CfnOutput it creates with an
// `exportName: exportName(stack.stackName, …)`. Because AgentCoreApplication
// lives in an Amplify *nested* stack, `stack.stackName` is an unresolved CDK
// token that stringifies to `TokenTOKEN<n>` — a per-synth counter, NOT the
// real (branch-unique) stack name. Two deployments (e.g. `main` and a leftover
// branch sandbox) that happen to land on the same counter value produce the
// SAME CloudFormation export name, and CloudFormation rejects the second with
// "Export … is already exported by stack …", rolling back the whole deploy.
// This blocked every `main` deploy after these exports were introduced (#52's
// deploy was the first casualty — its git/gh-auth Lambda code never shipped).
//
// Nothing imports these exports cross-stack (we read ARNs off same-stack
// tokens and via `describe-stacks` Outputs, never `Fn.importValue`), so strip
// the `exportName` from all of them. The plain Output value is still emitted —
// `aws cloudformation describe-stacks` surfaces it — just no longer collidable.
//
// Walk the *stack's* node tree, not `agentCoreApp`'s subtree: AgentCoreMcp
// attaches its Gateway `…-Arn`/`…-Id`/`…-Url` CfnOutputs to `stack` (see
// AgentCoreMcp.js), so they live OUTSIDE the AgentCoreApplication construct.
// A previous `agentCoreApp.node.findAll()` sweep caught the Memory outputs but
// silently missed the Gateway ones — leaving the exact export
// (`TokenTOKEN<n>-Gateway-default-gateway-Arn`) that collided across sandboxes
// and rolled back every `main` deploy.
for (const child of agentStack.node.findAll()) {
  if (child instanceof CfnOutput) {
    child.exportName = undefined;
  }
}

const firstHarnessMemory = harnessSpecs[0]?.memory;
const memoryName = firstHarnessMemory?.mode === 'existing' ? firstHarnessMemory.name : undefined;
// During the AGENTCORE_SKIP_HARNESS phase the harness isn't created, so its ARN
// accessors would throw — treat the harness as absent (ARNs resolve to '').
const harnessName = skipHarness ? undefined : harnessSpecs[0]?.name;
const gatewayName = projectSpec.agentCoreGateways?.[0]?.name;

const AGENTCORE_MEMORY_ID = memoryName ? agentCoreApp.memoryId(memoryName) : '';
const AGENTCORE_MEMORY_ARN = memoryName ? agentCoreApp.memoryArn(memoryName) : '';
const AGENTCORE_GATEWAY_ID = gatewayName ? agentCoreApp.gatewayId(gatewayName) : '';
const AGENTCORE_GATEWAY_ARN = gatewayName ? agentCoreApp.gatewayArn(gatewayName) : '';
const AGENTCORE_GATEWAY_ENDPOINT = gatewayName ? agentCoreApp.gatewayEndpoint(gatewayName) : '';
const AGENTCORE_HARNESS_ARN = harnessName ? agentCoreApp.harnessArn(harnessName) : '';
const AGENTCORE_HARNESS_ROLE_ARN = harnessName ? agentCoreApp.harnessRoleArn(harnessName) : '';
const AGENTCORE_REGION = Stack.of(agentStack).region;

// ClaudeCode AgentCore Runtime — the container agent invoked via
// @agentcore-claude on GitHub issues/PRs (see agent/default/app/ClaudeCode).
// Its name matches the runtime `name` in agentcore.json; runtimes are optional
// so this is '' when none are configured.
const claudeCodeRuntimeName = (projectSpec.runtimes ?? []).find(
  (r: { name: string }) => r.name === 'ClaudeCode',
)?.name;
const AGENTCORE_CLAUDE_CODE_RUNTIME_ARN = claudeCodeRuntimeName
  ? agentCoreApp.runtimeArn(claudeCodeRuntimeName)
  : '';

// AguiAgent AgentCore Runtime — the AG-UI-native runtime (issue #176) that
// emits AG-UI events directly instead of Bedrock Converse (see
// agent/default/app/AguiAgent). Additive alongside ClaudeCode/MyHarness;
// '' when not configured on this branch.
const aguiRuntimeName = (projectSpec.runtimes ?? []).find(
  (r: { name: string }) => r.name === 'AguiAgent',
)?.name;
const AGENTCORE_AGUI_RUNTIME_ARN = aguiRuntimeName
  ? agentCoreApp.runtimeArn(aguiRuntimeName)
  : '';

// MyHarness now authorizes with AWS_IAM, so the browser signs InvokeHarness
// requests with Cognito Identity Pool credentials (see web/lib/agentcore-transport.ts).

// Store AgentCore runtime identifiers in SSM Parameter Store to avoid cross-stack exports.
// Parameter names include the stack name (which encodes repo and sanitized branch) to
// keep values isolated per sandbox.
// simpleName: false on every parameter — the path is `/agentcore/<stackName>/…`
// and `stackName` is an unresolved CDK token here, so CDK can't infer from the
// name string that these are path-style ("/"-prefixed) rather than simple
// names. Without it synth fails with "Unable to determine ARN separator for SSM
// parameter since the parameter name is an unresolved token."
const ssmBasePath = `/agentcore/${Stack.of(agentStack).stackName}`;
// SSM PutParameter rejects an empty string value ("min length 1"), so skip any
// identifier that isn't present in this deployment (e.g. the harness ARN during
// an AGENTCORE_SKIP_HARNESS phase, or the gateway ARNs on a gateway-less branch)
// rather than failing the whole stack. Consumers already tolerate a missing
// parameter the same way they tolerate an empty env var.
const putAgentcoreParam = (id: string, suffix: string, value: string) => {
  if (!value) return;
  new StringParameter(agentStack, id, {
    parameterName: `${ssmBasePath}/${suffix}`,
    stringValue: value,
    simpleName: false,
  });
};
putAgentcoreParam('SsmAgentcoreMemoryId', 'memory_id', AGENTCORE_MEMORY_ID);
putAgentcoreParam('SsmAgentcoreMemoryArn', 'memory_arn', AGENTCORE_MEMORY_ARN);
putAgentcoreParam('SsmAgentcoreGatewayId', 'gateway_id', AGENTCORE_GATEWAY_ID);
putAgentcoreParam('SsmAgentcoreGatewayArn', 'gateway_arn', AGENTCORE_GATEWAY_ARN);
putAgentcoreParam('SsmAgentcoreGatewayEndpoint', 'gateway_endpoint', AGENTCORE_GATEWAY_ENDPOINT);
putAgentcoreParam('SsmAgentcoreHarnessArn', 'harness_arn', AGENTCORE_HARNESS_ARN);
putAgentcoreParam('SsmAgentcoreHarnessRoleArn', 'harness_role_arn', AGENTCORE_HARNESS_ROLE_ARN);
putAgentcoreParam('SsmAgentcoreRegion', 'region', AGENTCORE_REGION);
putAgentcoreParam('SsmAgentcoreClaudeCodeRuntimeArn', 'claude_code_runtime_arn', AGENTCORE_CLAUDE_CODE_RUNTIME_ARN);
putAgentcoreParam('SsmAgentcoreAguiRuntimeArn', 'agui_runtime_arn', AGENTCORE_AGUI_RUNTIME_ARN);

// Grant the pool's authenticated role permission to invoke the harness.
//
// Attach via a standalone Policy rather than `role.addToPrincipalPolicy(...)`:
// Amplify surfaces authenticatedUserIamRole as a role owned by the auth stack,
// and adding a principal policy to it silently no-ops — the statement never
// synthesizes onto the role (observed as an AccessDeniedException at invoke
// time). An AWS::IAM::Policy only needs the role name to attach, so create it
// in agentStack (which owns AGENTCORE_HARNESS_ARN and already depends on the
// auth stack for the AgUiHandler's Cognito config — so referencing the auth
// role here adds no new dependency and introduces no cycle).
if (AGENTCORE_HARNESS_ARN) {
  new Policy(agentStack, 'HarnessInvokeAuthPolicy', {
    roles: [backend.auth.resources.authenticatedUserIamRole],
    statements: [
      new PolicyStatement({
        // InvokeHarnessCommand checks BOTH IAM actions — InvokeAgentRuntime
        // and InvokeHarness (confirmed by successive AccessDenied errors,
        // each naming the missing one). Grant both.
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeHarness',
        ],
        resources: [AGENTCORE_HARNESS_ARN],
      }),
    ],
  });
}

// Grant the same authenticated role permission to invoke the ClaudeCode
// runtime directly (issue #204) — lets the chat UI drive it the same way the
// GitHub @agentcore-claude webhook does (see agentWebhookInvokeClaude above).
// Same resource shape as that Lambda's grant: InvokeAgentRuntime authorizes
// against the runtime's ENDPOINT sub-resource, not just the bare runtime ARN.
if (AGENTCORE_CLAUDE_CODE_RUNTIME_ARN) {
  new Policy(agentStack, 'ClaudeCodeRuntimeInvokeAuthPolicy', {
    roles: [backend.auth.resources.authenticatedUserIamRole],
    statements: [
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          AGENTCORE_CLAUDE_CODE_RUNTIME_ARN,
          `${AGENTCORE_CLAUDE_CODE_RUNTIME_ARN}/runtime-endpoint/*`,
        ],
      }),
    ],
  });
}

// Grant the same authenticated role permission to invoke the AguiAgent
// runtime directly (issue #176) — frontend wiring to actually use it is a
// separate follow-up, but the grant is additive and harmless to land now.
// Same resource shape as the ClaudeCode grant above.
if (AGENTCORE_AGUI_RUNTIME_ARN) {
  new Policy(agentStack, 'AguiRuntimeInvokeAuthPolicy', {
    roles: [backend.auth.resources.authenticatedUserIamRole],
    statements: [
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [
          AGENTCORE_AGUI_RUNTIME_ARN,
          `${AGENTCORE_AGUI_RUNTIME_ARN}/runtime-endpoint/*`,
        ],
      }),
    ],
  });
}

// ============================================================================
// BASIC AUTH CONFIGURATION
// ============================================================================

const { cfnUserPool, cfnUserPoolClient } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
cfnUserPoolClient.explicitAuthFlows = [
  'ALLOW_CUSTOM_AUTH',
  'ALLOW_REFRESH_TOKEN_AUTH',
  'ALLOW_USER_SRP_AUTH',
  'ALLOW_USER_PASSWORD_AUTH',
];

// ============================================================================
// AGENTCORE MEMORY — list-session-messages + update-session-summary Lambdas
// ============================================================================

backend.listSessionMessages.addEnvironment('AGENTCORE_MEMORY_ID', AGENTCORE_MEMORY_ID);
backend.updateSessionSummary.addEnvironment('AGENTCORE_MEMORY_ID', AGENTCORE_MEMORY_ID);

const listSessionMessagesLambda = backend.listSessionMessages.resources.lambda as LambdaFunction;
listSessionMessagesLambda.addToRolePolicy(new PolicyStatement({
  actions: ['bedrock-agentcore:ListEvents', 'bedrock-agentcore:ListMemoryRecords'],
  resources: [AGENTCORE_MEMORY_ARN],
}));

const updateSessionSummaryLambda = backend.updateSessionSummary.resources.lambda as LambdaFunction;
updateSessionSummaryLambda.addToRolePolicy(new PolicyStatement({
  actions: ['bedrock-agentcore:BatchUpdateMemoryRecords'],
  resources: [AGENTCORE_MEMORY_ARN],
}));

// ============================================================================
// REGISTER-MCP-TARGET Lambda — CreateGatewayTarget on the default gateway
// ============================================================================

backend.registerMcpTarget.addEnvironment('GATEWAY_ID', AGENTCORE_GATEWAY_ID);
backend.registerMcpTarget.addEnvironment('GATEWAY_REGION', AGENTCORE_REGION);

const registerMcpTargetLambda = backend.registerMcpTarget.resources.lambda as LambdaFunction;
registerMcpTargetLambda.addToRolePolicy(new PolicyStatement({
  actions: [
    'bedrock-agentcore:CreateGatewayTarget',
    'bedrock-agentcore:SynchronizeGatewayTargets',
  ],
  resources: ['*'],
}));

// ============================================================================
// S3-TOOLS Lambda — ApplyDiff/ListFiles/ReadFile/DeleteFile filesystem tools,
// exposed as a Lambda-backed AgentCore Gateway target (issue #240).
// ============================================================================

const s3ToolsLambda = backend.s3Tools.resources.lambda as LambdaFunction;
backend.s3Tools.addEnvironment('BUCKET_NAME', backend.agentWorkspace.resources.bucket.bucketName);

// Scoped to the files/ root prefix only — see web/lib/s3-fs-path.ts.
backend.agentWorkspace.resources.bucket.grantRead(s3ToolsLambda, 'files/*');
s3ToolsLambda.addToRolePolicy(new PolicyStatement({
  actions: ['s3:PutObject', 's3:DeleteObject'],
  resources: [`${backend.agentWorkspace.resources.bucket.bucketArn}/files/*`],
}));
s3ToolsLambda.addToRolePolicy(new PolicyStatement({
  actions: ['s3:ListBucket'],
  resources: [backend.agentWorkspace.resources.bucket.bucketArn],
  conditions: { StringLike: { 's3:prefix': ['files/*'] } },
}));

if (AGENTCORE_GATEWAY_ARN) {
  s3ToolsLambda.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: AGENTCORE_GATEWAY_ARN,
  });
}

// The resource-based permission above is only half of what
// CreateGatewayTarget validates synchronously: the gateway's *execution
// role* also needs an identity-based lambda:InvokeFunction grant on this
// Lambda. The @aws/agentcore-cdk Gateway component auto-adds that only for
// targets it creates itself from agentcore.json; this target is registered
// out-of-band via S3ToolsGatewayTarget, so that auto-grant never runs and
// CreateGatewayTarget would 400 without this explicit grant.
if (gatewayName) {
  agentCoreApp.addGatewayRolePolicy(gatewayName, new PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [s3ToolsLambda.functionArn, `${s3ToolsLambda.functionArn}:*`],
  }));
}

// Registers the Lambda as a gateway target exposing the 4 filesystem tools,
// and seeds a demo Agent + McpServer + AgentMcpServer join so the tools are
// reachable end-to-end from the chat UI (see both constructs' resource.ts).
// Own stack (not agentStack, not the function stack): these constructs
// reference tokens from BOTH the function stack (s3ToolsLambda.functionArn)
// and the data stack (the GraphQL URL) — nesting them inside agentStack would
// make agentStack depend on those stacks, which already depend on agentStack
// (function-stack Lambdas read AGENTCORE_* envs; see the AgentWebhookStack
// comment above for the identical cycle this avoids).
if (AGENTCORE_GATEWAY_ID) {
  const s3ToolsTargetName = toGatewayResourceName(
    's3-tools',
    backendNamespace ?? '',
    backendName ?? '',
  ).slice(0, 100);

  const s3ToolsCdkStack = backend.createStack('s3-tools');

  new S3ToolsGatewayTarget(s3ToolsCdkStack, 'S3ToolsGatewayTarget', {
    gatewayIdentifier: AGENTCORE_GATEWAY_ID,
    gatewayArn: AGENTCORE_GATEWAY_ARN,
    targetName: s3ToolsTargetName,
    lambdaArn: s3ToolsLambda.functionArn,
  });

  if (AGENTCORE_GATEWAY_ENDPOINT) {
    new S3ToolsMcpServerSeed(s3ToolsCdkStack, 'S3ToolsMcpServerSeed', {
      graphqlUrl: backend.data.resources.cfnResources.cfnGraphqlApi.attrGraphQlUrl,
      graphqlRegion: AGENTCORE_REGION,
      graphqlApiId: backend.data.resources.cfnResources.cfnGraphqlApi.attrApiId,
      gatewayEndpoint: AGENTCORE_GATEWAY_ENDPOINT,
    });
  }
}

// ============================================================================
// INVOKE-AGENT Lambda — sub-agent dispatcher via AgentCore harness
// ============================================================================

backend.invokeAgent.addEnvironment('HARNESS_ARN', AGENTCORE_HARNESS_ARN);

const invokeAgentLambda = backend.invokeAgent.resources.lambda as LambdaFunction;

// MyHarness authorizes with AWS_IAM: this Lambda invokes it via the SDK's
// InvokeHarnessCommand, signed with its own execution-role credentials — no
// Cognito service account / SSM password needed anymore. InvokeHarnessCommand
// checks both the InvokeAgentRuntime and InvokeHarness IAM actions.
// Guard on a non-empty ARN: when AGENTCORE_SKIP_HARNESS=1 the harness isn't
// deployed and AGENTCORE_HARNESS_ARN is '' — an empty IAM policy Resource is
// rejected ("Resource must be in ARN format or *"), so skip the grant.
if (AGENTCORE_HARNESS_ARN) {
  invokeAgentLambda.addToRolePolicy(new PolicyStatement({
    actions: [
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:InvokeHarness',
    ],
    resources: [AGENTCORE_HARNESS_ARN],
  }));
}

// ============================================================================
// MINT-GITHUB-TOKEN Lambda — short-lived GitHub App installation tokens.
//
// Replaces long-lived PAT usage for browser-initiated (/chat-handler) sessions
// (see issue #34). GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_SECRET_ARN are
// deploy-time inputs, not resources this stack creates — the GitHub App and
// its private key (stored in Secrets Manager as a plaintext PEM secret) are
// provisioned manually per docs/github-integration.md. Both env vars are
// intentionally allowed to be empty at synth time so branch deploys that
// don't set them still succeed; the mutation just fails at invoke time with
// a clear error instead of failing the whole deploy.
// ============================================================================

const GITHUB_APP_PRIVATE_KEY_SECRET_ARN = process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ARN ?? '';

const mintGithubTokenLambda = backend.mintGithubToken.resources.lambda as LambdaFunction;

if (GITHUB_APP_PRIVATE_KEY_SECRET_ARN) {
  mintGithubTokenLambda.addToRolePolicy(new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [GITHUB_APP_PRIVATE_KEY_SECRET_ARN],
  }));
}

// ============================================================================
// AGENT WEBHOOK — API Gateway → Step Function pipeline for GitHub/Jira
// mention comments (see issue #35, docs/webhook-stepfunction-integration.md).
// This is now the sole GitHub/Jira mention pipeline — it superseded the
// Actions-based .github/workflows/agent-mention.yml flow, which targeted the
// since-retired AgUiHandler runtime (#33) and was removed (#191).
//
// All *_SECRET_ARN / *_ARN inputs below are deploy-time inputs (Secrets
// Manager secrets provisioned manually, same pattern as
// GITHUB_APP_PRIVATE_KEY_SECRET_ARN above) — intentionally allowed to be
// empty at synth so branch deploys without them still succeed; the receiver
// Lambda fails cleanly at invoke time instead of failing the whole deploy.
// ============================================================================

// GitHub webhook HMAC secret is now an Amplify secret() wired directly in
// agent-webhook-receiver/resource.ts (issue #239) — Amplify injects the value
// and grants read access automatically, so it needs no ARN env var or manual
// GetSecretValue grant here. Jira's secret stays on the optional ARN pattern.
const JIRA_WEBHOOK_SECRET_ARN = process.env.JIRA_WEBHOOK_SECRET_ARN ?? '';
const JIRA_API_TOKEN_SECRET_ARN = process.env.JIRA_API_TOKEN_SECRET_ARN ?? '';

const webhookReceiverLambda = backend.agentWebhookReceiver.resources.lambda as LambdaFunction;
const webhookPostCommentLambda = backend.agentWebhookPostComment.resources.lambda as LambdaFunction;
const webhookInvokeAgentLambda = backend.agentWebhookInvokeAgent.resources.lambda as LambdaFunction;
const webhookInvokeClaudeLambda = backend.agentWebhookInvokeClaude.resources.lambda as LambdaFunction;
const webhookAuthorizerLambda = backend.agentWebhookAuthorizer.resources.lambda as LambdaFunction;

// The harness INVOKE is now a native `bedrockagentcore:invokeHarness` Step
// Functions task (see agentWebhookStack + issue #56). This Lambda only performs
// the pre-invoke git-auth exec (InvokeAgentRuntimeCommand), SigV4-signed with
// its own execution-role credentials against the harness ARN.
backend.agentWebhookInvokeAgent.addEnvironment('HARNESS_ARN', AGENTCORE_HARNESS_ARN);
backend.agentWebhookPostComment.addEnvironment('ACCOUNT_ID', backend.stack.account);
backend.agentWebhookPostComment.addEnvironment('HOSTING_DOMAIN', hosting.distributionDomainName);
backend.agentWebhookPostComment.addEnvironment('BRANCH_SLUG', backendName ?? '');
backend.agentWebhookPostComment.addEnvironment('CLAUDE_CODE_RUNTIME_ARN', AGENTCORE_CLAUDE_CODE_RUNTIME_ARN);

// Only Jira's secret is still fetched from Secrets Manager at runtime; the
// GitHub webhook secret is an Amplify secret() (auto-granted). Grant the read
// only when Jira is configured on this branch.
if (JIRA_WEBHOOK_SECRET_ARN) {
  webhookReceiverLambda.addToRolePolicy(new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [JIRA_WEBHOOK_SECRET_ARN],
  }));
}
if (GITHUB_APP_PRIVATE_KEY_SECRET_ARN) {
  webhookPostCommentLambda.addToRolePolicy(new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [GITHUB_APP_PRIVATE_KEY_SECRET_ARN],
  }));
}
if (JIRA_API_TOKEN_SECRET_ARN) {
  webhookPostCommentLambda.addToRolePolicy(new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [JIRA_API_TOKEN_SECRET_ARN],
  }));
}

webhookPostCommentLambda.addToRolePolicy(new PolicyStatement({
  actions: ['logs:CreateLogGroup', 'logs:CreateLogStream'],
  resources: [`arn:aws:logs:${AGENTCORE_REGION}:${backend.stack.account}:log-group:/agent-webhook/*`],
}));
webhookInvokeAgentLambda.addToRolePolicy(new PolicyStatement({
  actions: ['logs:PutLogEvents'],
  resources: [`arn:aws:logs:${AGENTCORE_REGION}:${backend.stack.account}:log-group:/agent-webhook/*:log-stream:*`],
}));
// This Lambda now only runs the git-auth exec (InvokeAgentRuntimeCommand → POST
// /runtimes/{harnessArn}/commands — see docs/webhook-stepfunction-integration.md
// "Git access"). The harness turn moved to the native Step Functions task, whose
// InvokeHarness grant lives on the state machine role (in agentWebhookStack).
// Guarded on a non-empty ARN — when AGENTCORE_SKIP_HARNESS=1 the harness ARN is
// '' and an empty IAM policy Resource is rejected ("must be in ARN format or *").
if (AGENTCORE_HARNESS_ARN) {
  webhookInvokeAgentLambda.addToRolePolicy(new PolicyStatement({
    actions: [
      'bedrock-agentcore:InvokeAgentRuntime',
      'bedrock-agentcore:InvokeAgentRuntimeCommand',
    ],
    resources: [AGENTCORE_HARNESS_ARN],
  }));
}

// The @agentcore-claude branch: this Lambda calls InvokeAgentRuntime on the
// ClaudeCode runtime (SigV4-signed with its own execution-role creds) and
// reshapes the reply into the shared $.agentResult shape. Env + grant skipped
// cleanly when the runtime isn't deployed on this branch (ARN empty).
backend.agentWebhookInvokeClaude.addEnvironment('CLAUDE_CODE_RUNTIME_ARN', AGENTCORE_CLAUDE_CODE_RUNTIME_ARN);
if (AGENTCORE_CLAUDE_CODE_RUNTIME_ARN) {
  webhookInvokeClaudeLambda.addToRolePolicy(new PolicyStatement({
    actions: ['bedrock-agentcore:InvokeAgentRuntime'],
    // InvokeAgentRuntime authorizes against the runtime's ENDPOINT sub-resource
    // (arn:.../runtime/<id>/runtime-endpoint/DEFAULT), not just the bare runtime
    // ARN — a grant on the runtime ARN alone yields AccessDeniedException
    // ("no identity-based policy allows the bedrock-agentcore:InvokeAgentRuntime
    // action" on .../runtime-endpoint/DEFAULT). Grant both the runtime and all
    // its endpoints so the SigV4 call from the @agentcore-claude branch succeeds.
    resources: [
      AGENTCORE_CLAUDE_CODE_RUNTIME_ARN,
      `${AGENTCORE_CLAUDE_CODE_RUNTIME_ARN}/runtime-endpoint/*`,
    ],
  }));
}
// Best-effort Live Tail logging from the Claude branch (same log-group scheme).
webhookInvokeClaudeLambda.addToRolePolicy(new PolicyStatement({
  actions: ['logs:PutLogEvents'],
  resources: [`arn:aws:logs:${AGENTCORE_REGION}:${backend.stack.account}:log-group:/agent-webhook/*:log-stream:*`],
}));

// Last-write-wins cancellation (issue #182): the receiver also calls
// InvokeAgentRuntime on the ClaudeCode runtime — with a `{ action: 'cancel' }`
// control payload rather than a real job — to kill a prior in-flight
// @agentcore-claude job before starting its replacement (see server.js's
// cancel handler). Same grant shape as webhookInvokeClaudeLambda above. Env +
// grant skipped cleanly when the runtime isn't deployed on this branch.
backend.agentWebhookReceiver.addEnvironment('CLAUDE_CODE_RUNTIME_ARN', AGENTCORE_CLAUDE_CODE_RUNTIME_ARN);
if (AGENTCORE_CLAUDE_CODE_RUNTIME_ARN) {
  webhookReceiverLambda.addToRolePolicy(new PolicyStatement({
    actions: ['bedrock-agentcore:InvokeAgentRuntime'],
    resources: [
      AGENTCORE_CLAUDE_CODE_RUNTIME_ARN,
      `${AGENTCORE_CLAUDE_CODE_RUNTIME_ARN}/runtime-endpoint/*`,
    ],
  }));
}

// Own stack (not agentStack) — AgentWebhookStack references the function-stack
// Lambdas above, which already depend on agentStack (via the HARNESS_ARN
// env var). Building it inside agentStack would make agentStack depend back
// on the function stack, forming the same nested-stack cycle CloudFormation
// rejects for the invokeHandler resolver wiring above.
const agentWebhookCdkStack = backend.createStack('agent-webhook');
const agentWebhookStack = new AgentWebhookStack(agentWebhookCdkStack, 'AgentWebhook', {
  receiverLambda: webhookReceiverLambda,
  authorizerLambda: webhookAuthorizerLambda,
  postCommentLambda: webhookPostCommentLambda,
  // Git-auth prep only — the harness invoke is the native task in the stack,
  // granted InvokeHarness on the state machine role via harnessArn below.
  prepareGitAuthLambda: webhookInvokeAgentLambda,
  // @agentcore-claude branch — invokes the ClaudeCode runtime.
  invokeClaudeLambda: webhookInvokeClaudeLambda,
  claudeCodeRuntimeArn: AGENTCORE_CLAUDE_CODE_RUNTIME_ARN,
  harnessArn: AGENTCORE_HARNESS_ARN,
  // Physical name unique per sandbox/branch (same scheme as the AgentCore
  // gateway name above) so concurrent deployments in the same account never
  // collide on state machine names. State machine names are capped at 80
  // chars — tighter than toGatewayResourceName's generic 100.
  stateMachineName: toGatewayResourceName('agent-webhook', backendNamespace ?? '', backendName ?? '').slice(0, 80),
});

backend.agentWebhookReceiver.addEnvironment('STATE_MACHINE_ARN', agentWebhookStack.stateMachineArn);

// The @agentcore-claude branch uses the Step Functions callback pattern
// (WAIT_FOR_TASK_TOKEN, issue #175): the InvokeClaude task pauses on a task
// token and the ClaudeCode RUNTIME resumes it when the (possibly hours-long)
// job finishes, calling SendTaskSuccess/SendTaskFailure with its own execution-
// role credentials. Grant that role states:SendTask* on the webhook state
// machine ARN. Guarded on the runtime being deployed (mirrors the invoke
// Lambda's InvokeAgentRuntime grant above) — skipped cleanly otherwise. The
// state machine ARN is a plain string, so no cross-stack token cycle.
if (claudeCodeRuntimeName) {
  agentCoreApp.addRuntimeRolePolicy(claudeCodeRuntimeName, new PolicyStatement({
    actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
    resources: [agentWebhookStack.stateMachineArn],
  }));

  // Let the ClaudeCode runtime write its own ActiveRun snapshots straight to
  // AppSync via SigV4 (issue #15, server-side producer) — the runtime's own
  // execution-role credentials are a valid IAM principal for the GraphQL API,
  // exactly like scripts/graphql.sh's local SigV4 calls. A wildcard string ARN
  // (not backend.data's real API ARN) keeps this a plain string with no CDK
  // token, so it can't introduce a data-stack -> agent-stack cycle the way
  // referencing backend.data's ARN here would (see PR #230).
  //
  // Both Query AND Mutation fields are needed: active-run.js does a
  // list-then-upsert (listActiveRunBySession is a *Query* field) and
  // clearActiveRun lists before deleting — a Mutation-only grant would
  // implicit-deny every listActiveRunBySession call, and since those errors are
  // swallowed the row would silently never be created or cleared.
  agentCoreApp.addRuntimeRolePolicy(claudeCodeRuntimeName, new PolicyStatement({
    actions: ['appsync:GraphQL'],
    resources: [
      'arn:aws:appsync:*:*:apis/*/types/Query/fields/*',
      'arn:aws:appsync:*:*:apis/*/types/Mutation/fields/*',
    ],
  }));

  // The runtime learns the GraphQL endpoint + region at startup from an SSM
  // parameter published post-deploy by scripts/build.sh (see the e2e-config
  // param above for the same pattern) — not a CDK env var built from a
  // data-stack token, which would reintroduce the cycle just avoided above.
  agentCoreApp.addRuntimeRolePolicy(claudeCodeRuntimeName, new PolicyStatement({
    actions: ['ssm:GetParameter'],
    resources: ['arn:aws:ssm:*:*:parameter/outputs/*'],
  }));

  // Tell the runtime exactly which SSM path to read, computed the same way
  // build.sh derives the path it publishes to (repo slug from GITHUB_REPOSITORY,
  // branch slug from `backendName` — the CDK context value `ampx --identifier`
  // sets to the same BRANCH_SLUG build.sh uses). Both sides are plain strings
  // (no data-stack token), so this can't reintroduce the cycle avoided above.
  const activeRunRepoSlug = (process.env.GITHUB_REPOSITORY ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-');
  if (activeRunRepoSlug && backendName) {
    agentCoreApp.addRuntimeEnvironmentVariable(
      claudeCodeRuntimeName,
      'ACTIVERUN_GRAPHQL_SSM_PATH',
      `/outputs/${activeRunRepoSlug}/${backendName}/activerun-graphql`,
    );
  }
}

// Persist Claude Code's own turns into the same MyHarnessMemory resource the
// harness half uses (issue #186), so a run started via @agentcore-claude shows
// up in the chat UI (HarnessAgent.loadHistory reads the same memory/session).
// The runtime discovers the memory id/region via env vars (it calls CreateEvent
// itself — see agent/default/app/ClaudeCode/server.js) rather than through the
// agentcore.json envVars list, because the memory id is a deploy-time CDK token,
// not something that can be hardcoded in that static config file.
if (claudeCodeRuntimeName && AGENTCORE_MEMORY_ID) {
  agentCoreApp.addRuntimeEnvironmentVariable(claudeCodeRuntimeName, 'AGENTCORE_MEMORY_ID', AGENTCORE_MEMORY_ID);
  agentCoreApp.addRuntimeEnvironmentVariable(claudeCodeRuntimeName, 'AGENTCORE_MEMORY_REGION', AGENTCORE_REGION);
  agentCoreApp.addRuntimeRolePolicy(claudeCodeRuntimeName, new PolicyStatement({
    actions: ['bedrock-agentcore:CreateEvent'],
    resources: [AGENTCORE_MEMORY_ARN],
  }));
}

// Same wiring for the AguiAgent runtime (issue #176) — it writes its own
// turns into the same MyHarnessMemory resource (see
// agent/default/app/AguiAgent/memory.ts) so a run through this runtime shows
// up in the chat UI's session history alongside harness/ClaudeCode runs.
if (aguiRuntimeName && AGENTCORE_MEMORY_ID) {
  agentCoreApp.addRuntimeEnvironmentVariable(aguiRuntimeName, 'AGENTCORE_MEMORY_ID', AGENTCORE_MEMORY_ID);
  agentCoreApp.addRuntimeEnvironmentVariable(aguiRuntimeName, 'AGENTCORE_MEMORY_REGION', AGENTCORE_REGION);
  agentCoreApp.addRuntimeRolePolicy(aguiRuntimeName, new PolicyStatement({
    actions: ['bedrock-agentcore:CreateEvent'],
    resources: [AGENTCORE_MEMORY_ARN],
  }));
}

// ============================================================================
// E2E TEST USER — Cognito user + SSM-stored credentials for Playwright auth.
//
// Created via a CDK custom resource instead of the e2e suite bootstrapping
// its own user with AdminCreateUser at test time — that required granting
// cognito-idp:AdminCreateUser to whatever role runs the tests. Here that
// permission is scoped to the deploy-time custom resource's own role; the
// test runner only needs ssm:GetParameter (see web/e2e/auth.setup.ts).
// SSM paths are branch/sandbox-scoped so concurrent deployments don't share
// (or clobber) the same test user.
// ============================================================================

const e2eTestUserResourceId = toGatewayResourceName(backendNamespace ?? '', backendName ?? '') || 'default';
const E2E_TEST_USER_EMAIL_SSM_PATH = `/agentcore/e2e-test-user-${e2eTestUserResourceId}/email`;
const E2E_TEST_USER_PASSWORD_SSM_PATH = `/agentcore/e2e-test-user-${e2eTestUserResourceId}/password`;

new E2eTestUser(agentStack, 'E2eTestUser', {
  userPoolId: backend.auth.resources.userPool.userPoolId,
  userPoolArn: backend.auth.resources.userPool.userPoolArn,
  email: `e2e-test-${e2eTestUserResourceId}@agentcore.dev`,
  emailSsmPath: E2E_TEST_USER_EMAIL_SSM_PATH,
  passwordSsmPath: E2E_TEST_USER_PASSWORD_SSM_PATH,
});

if (AGENTCORE_GATEWAY_ARN) {
  invokeAgentLambda.addPermission('AllowGatewayInvoke', {
    principal: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    action: 'lambda:InvokeFunction',
    sourceArn: AGENTCORE_GATEWAY_ARN,
  });
}

// The GraphQL API's CfnResource, referenced by the appsync_api_id output below.
const cfnGraphqlApi = backend.data.resources.cfnResources.cfnGraphqlApi;

// ============================================================================
// EXPORTS — consumed by the frontend via amplify_outputs.json custom outputs
// ============================================================================

backend.addOutput({
  custom: {
    auth_authenticated_role_arn: backend.auth.resources.authenticatedUserIamRole.roleArn,
    auth_unauthenticated_role_arn: backend.auth.resources.unauthenticatedUserIamRole.roleArn,
    invoke_agent_lambda_arn: invokeAgentLambda.functionArn,
    // Hosting outputs
    hosting_bucket_name: hosting.bucket.bucketName,
    hosting_distribution_id: hosting.distribution.distributionId,
    hosting_domain: hosting.distributionDomainName,
    // AgentCore harness/memory/gateway outputs — replaces web/deployment-info.json
    agentcore_region: AGENTCORE_REGION,
    agentcore_memory_id: AGENTCORE_MEMORY_ID,
    agentcore_memory_arn: AGENTCORE_MEMORY_ARN,
    agentcore_harness_arn: AGENTCORE_HARNESS_ARN,
    agentcore_harness_role_arn: AGENTCORE_HARNESS_ROLE_ARN,
    agentcore_gateway_id: AGENTCORE_GATEWAY_ID,
    agentcore_gateway_arn: AGENTCORE_GATEWAY_ARN,
    agentcore_gateway_endpoint: AGENTCORE_GATEWAY_ENDPOINT,
    agentcore_claude_code_runtime_arn: AGENTCORE_CLAUDE_CODE_RUNTIME_ARN,
    appsync_api_id: cfnGraphqlApi.attrApiId,
    // e2e test user credentials — see web/e2e/auth.setup.ts
    e2e_test_user_email_ssm_path: E2E_TEST_USER_EMAIL_SSM_PATH,
    e2e_test_user_password_ssm_path: E2E_TEST_USER_PASSWORD_SSM_PATH,
    // Agent webhook — see docs/webhook-stepfunction-integration.md
    agent_webhook_url: agentWebhookStack.webhookUrl,
    agent_webhook_state_machine_arn: agentWebhookStack.stateMachineArn,
  },
});

// ============================================================================
// E2E CONFIG — this used to be a CDK-owned SSM StringParameter with a fixed
// name (/outputs/<repoSlug>/<branchSlug>/e2e-config). A fixed logical name on
// a resource CloudFormation doesn't fully own is fragile: if a deploy that
// first creates it later rolls back for an unrelated reason, CFN can leave
// the SSM parameter orphaned (exists in Parameter Store, owned by no stack),
// and every subsequent deploy's CREATE of that resource then fails with
// AlreadyExists — a self-perpetuating wedge (see issue #192).
//
// scripts/fetch-e2e-config.ts only ever reads this parameter — nothing
// requires CloudFormation to own it. So it's now published by
// `aws ssm put-parameter --overwrite` in scripts/build.sh, run after this
// stack deploys, sourced from this stack's own outputs (amplify_outputs.json)
// — idempotent, self-healing after a rollback, no orphan possible. See that
// script for the write, and docs/e2e-testing.md for the full flow.
//
// The values below stay part of the custom outputs mainly so build.sh can
// read them back out of amplify_outputs.json without re-deriving anything.
// ============================================================================
