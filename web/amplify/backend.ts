import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { listSessionMessages } from './functions/list-session-messages/resource';
import { updateSessionSummary } from './functions/update-session-summary/resource';
import { listMcpTools } from './functions/list-mcp-tools/resource';
import { invokeAgent } from './functions/invoke-agent/resource';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Fn, Stack } from 'aws-cdk-lib';
import { HostingConstruct } from './constructs/hostingConstruct';
import { AgentCoreApplication, type HarnessSpecInput } from './constructs/agentCoreApplication';
import { E2eTestUser } from './constructs/e2eTestUser/resource';

// ============================================================================
// AGENTCORE CONFIG — declared inline (no agentcore.json / harness.json files,
// no `agentcore` CLI project). This is the single source of truth for the
// harness + memory this stack deploys.
// ============================================================================

const harnessSpecs: HarnessSpecInput[] = [
  {
    name: 'MyHarness',
    model: {
      provider: 'bedrock',
      modelId: 'global.anthropic.claude-sonnet-4-6',
      apiFormat: 'converse_stream',
    },
    tools: [
      { type: 'agentcore_browser', name: 'browser' },
      { type: 'agentcore_code_interpreter', name: 'code-interpreter' },
    ],
    memory: { name: 'MyHarnessMemory' },
    truncation: { strategy: 'summarization' },
    authorizerType: 'CUSTOM_JWT',
  },
];

const memorySpecs = [
  {
    name: 'MyHarnessMemory',
    eventExpiryDuration: 30,
    strategies: [
      { type: 'SEMANTIC' as const, namespaces: ['/users/{actorId}/facts'] },
      { type: 'USER_PREFERENCE' as const, namespaces: ['/users/{actorId}/preferences'] },
      { type: 'SUMMARIZATION' as const, namespaces: ['/summaries/{actorId}/{sessionId}'] },
      {
        type: 'EPISODIC' as const,
        namespaces: ['/episodes/{actorId}/{sessionId}'],
        reflectionNamespaces: ['/episodes/{actorId}'],
      },
    ],
  },
];

// Harness/Memory physical names are `${projectName}_${name}`, constrained by
// the AgentCore API to ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ (max 48 chars total,
// alnum+underscore only). A fixed projectName collides across sandboxes/
// branches deployed to the same account, so make it unique per deployment by
// suffixing with the Amplify backend namespace+name (same CDK context keys
// the `ampx` deployer injects — see @aws-amplify/platform-core's
// CDKContextKey).
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
  listMcpTools,
  invokeAgent,
});

backend.stack.tags.setTag('Project', 'workshop');
backend.stack.tags.setTag('RootStack', backend.stack.stackName);

// `ampx` (sandbox and pipeline-deploy) injects these CDK context values before
// synth — see @aws-amplify/platform-core's CDKContextKey (amplify-backend-namespace/
// -name). namespace is the app id (or local package name for sandboxes); name is the
// branch (or sandbox identifier, e.g. the BRANCH_SLUG scripts/build.sh passes via
// `ampx sandbox --identifier`). Concatenating them gives every deployment — each
// branch, each developer's sandbox — its own physical harness/memory name.
const backendNamespace = backend.stack.node.tryGetContext('amplify-backend-namespace') as string | undefined;
const backendName = backend.stack.node.tryGetContext('amplify-backend-name') as string | undefined;

// ============================================================================
// HOSTING STACK — S3 + CloudFront static website hosting
// ============================================================================

const hostingStack = backend.createStack('hosting');
const hosting = new HostingConstruct(hostingStack, 'Hosting');

// ============================================================================
// AGENT STACK — AgentCore Harness + Memory (declared inline above)
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

// Re-derive discoveryUrl/allowedClients from *this* stack's user pool so a
// harness declared as CUSTOM_JWT always authorizes against the Cognito user
// pool it's actually deployed alongside (see issue #56).
const harnessSpecsWithAuth: HarnessSpecInput[] = harnessSpecs.map((h) =>
  h.authorizerType === 'CUSTOM_JWT'
    ? {
        ...h,
        authorizerConfiguration: {
          customJwtAuthorizer: {
            discoveryUrl: cognitoDiscoveryUrl,
            allowedClients: [backend.auth.resources.userPoolClient.userPoolClientId],
          },
        },
      }
    : h,
);

// Harness/Memory physical names are `${projectName}_${name}`, capped at 48 chars
// total (alnum+underscore only). Reserve enough room for the longest configured
// harness/memory logical name plus the joining underscore, then fit the unique
// projectName into whatever's left.
const longestResourceNameLength = Math.max(
  1,
  ...harnessSpecs.map((h) => h.name.length),
  ...memorySpecs.map((m) => m.name.length),
);
const uniqueProjectName = toAgentCoreProjectName(
  48 - 1 - longestResourceNameLength,
  'default',
  backendNamespace ?? '',
  backendName ?? '',
);

const agentCoreApp = new AgentCoreApplication(agentStack, 'AgentCoreApplication', {
  projectName: uniqueProjectName,
  memories: memorySpecs,
  harnesses: harnessSpecsWithAuth,
});

const memoryName = harnessSpecs[0]?.memory?.name;
const harnessName = harnessSpecs[0]?.name;

const AGENTCORE_MEMORY_ID = memoryName ? agentCoreApp.memoryId(memoryName) : '';
const AGENTCORE_MEMORY_ARN = memoryName ? agentCoreApp.memoryArn(memoryName) : '';
const AGENTCORE_HARNESS_ARN = harnessName ? agentCoreApp.harnessArn(harnessName) : '';
const AGENTCORE_HARNESS_ROLE_ARN = harnessName ? agentCoreApp.harnessRoleArn(harnessName) : '';
const AGENTCORE_REGION = Stack.of(agentStack).region;

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
// INVOKE-AGENT Lambda — sub-agent dispatcher via AgentCore harness
// ============================================================================

backend.invokeAgent.addEnvironment('HARNESS_ARN', AGENTCORE_HARNESS_ARN);

const invokeAgentLambda = backend.invokeAgent.resources.lambda as LambdaFunction;

invokeAgentLambda.addToRolePolicy(new PolicyStatement({
  actions: [
    'bedrock-agentcore:InvokeAgentRuntime',
    'bedrock-agentcore:InvokeHarness',
  ],
  resources: [AGENTCORE_HARNESS_ARN],
}));

const SVC_SSM_PATH = '/agentcore/invoke-agent-service/password';
backend.invokeAgent.addEnvironment('COGNITO_USER_POOL_ID', backend.auth.resources.userPool.userPoolId);
backend.invokeAgent.addEnvironment('COGNITO_CLIENT_ID', backend.auth.resources.userPoolClient.userPoolClientId);
backend.invokeAgent.addEnvironment('SERVICE_ACCOUNT_USERNAME', 'invoke-agent-service@internal.local');
backend.invokeAgent.addEnvironment('SERVICE_ACCOUNT_SSM_PATH', SVC_SSM_PATH);

invokeAgentLambda.addToRolePolicy(new PolicyStatement({
  actions: ['ssm:GetParameter'],
  resources: [
    `arn:aws:ssm:${AGENTCORE_REGION}:${backend.stack.account}:parameter${SVC_SSM_PATH}`,
  ],
}));

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

const e2eTestUserResourceId =
  [backendNamespace, backendName]
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'default';
const E2E_TEST_USER_EMAIL_SSM_PATH = `/agentcore/e2e-test-user-${e2eTestUserResourceId}/email`;
const E2E_TEST_USER_PASSWORD_SSM_PATH = `/agentcore/e2e-test-user-${e2eTestUserResourceId}/password`;

new E2eTestUser(agentStack, 'E2eTestUser', {
  userPoolId: backend.auth.resources.userPool.userPoolId,
  userPoolArn: backend.auth.resources.userPool.userPoolArn,
  email: `e2e-test-${e2eTestUserResourceId}@agentcore.dev`,
  emailSsmPath: E2E_TEST_USER_EMAIL_SSM_PATH,
  passwordSsmPath: E2E_TEST_USER_PASSWORD_SSM_PATH,
});

// ============================================================================
// EXPORTS — consumed by the frontend via amplify_outputs.json custom outputs
// ============================================================================

const cfnGraphqlApi = backend.data.resources.cfnResources.cfnGraphqlApi;

backend.addOutput({
  custom: {
    auth_authenticated_role_arn: backend.auth.resources.authenticatedUserIamRole.roleArn,
    auth_unauthenticated_role_arn: backend.auth.resources.unauthenticatedUserIamRole.roleArn,
    invoke_agent_lambda_arn: invokeAgentLambda.functionArn,
    // Hosting outputs
    hosting_bucket_name: hosting.bucket.bucketName,
    hosting_distribution_id: hosting.distribution.distributionId,
    hosting_domain: hosting.distributionDomainName,
    // AgentCore harness/memory outputs
    agentcore_region: AGENTCORE_REGION,
    agentcore_memory_id: AGENTCORE_MEMORY_ID,
    agentcore_memory_arn: AGENTCORE_MEMORY_ARN,
    agentcore_harness_arn: AGENTCORE_HARNESS_ARN,
    agentcore_harness_role_arn: AGENTCORE_HARNESS_ROLE_ARN,
    appsync_api_id: cfnGraphqlApi.attrApiId,
    // e2e test user credentials — see web/e2e/auth.setup.ts
    e2e_test_user_email_ssm_path: E2E_TEST_USER_EMAIL_SSM_PATH,
    e2e_test_user_password_ssm_path: E2E_TEST_USER_PASSWORD_SSM_PATH,
  },
});
