import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import type { Memory, AgentEnvSpec, PolicyEngine, AgentCoreMcpSpec, DirectoryPath, FilePath } from '@aws/agentcore-cdk';

// ============================================================================
// AGENTCORE CONFIG — the typed replacement for the legacy `agentcore.json`
// (see the sentinel file in this same directory for why a same-named,
// near-empty `agentcore.json` still has to exist). `backend.ts` imports these
// consts and feeds them to the `AgentCoreApplication` L3 CDK construct.
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Base project name; `backend.ts` suffixes this per-deployment (sandbox/branch) to keep physical names unique. */
export const projectName = 'default';

/** `web/amplify` — the directory containing the `agentcore/` sentinel dir, for `setSessionProjectRoot`. */
export const agentcoreProjectRoot = resolve(__dirname, '..');

export const memories: Memory[] = [
  {
    name: 'MyHarnessMemory',
    eventExpiryDuration: 30,
    strategies: [
      {
        type: 'SEMANTIC',
        namespaces: ['/users/{actorId}/facts'],
      },
      {
        type: 'USER_PREFERENCE',
        namespaces: ['/users/{actorId}/preferences'],
      },
      {
        type: 'SUMMARIZATION',
        namespaces: ['/summaries/{actorId}/{sessionId}'],
      },
      {
        type: 'EPISODIC',
        namespaces: ['/episodes/{actorId}/{sessionId}'],
        reflectionNamespaces: ['/episodes/{actorId}'],
      },
    ],
  },
];

// codeLocation is an absolute path (resolveCodeLocation() passes absolute
// paths through unchanged), so these runtimes are decoupled from wherever
// the agentcore.json sentinel happens to live.
export const runtimes: AgentEnvSpec[] = [
  {
    name: 'ClaudeCode',
    description:
      'Claude Code CLI hosted in AgentCore Runtime; invoked via @agentcore-claude on GitHub issues/PRs.',
    build: 'Container',
    codeLocation: resolve(__dirname, 'ClaudeCode') as DirectoryPath,
    dockerfile: 'Dockerfile',
    entrypoint: 'server.js' as FilePath,
    protocol: 'HTTP',
    networkMode: 'PUBLIC',
    filesystemConfigurations: [
      {
        sessionStorage: {
          mountPath: '/mnt/workspace',
        },
      },
    ],
    envVars: [
      {
        name: 'ANTHROPIC_MODEL',
        value: 'us.anthropic.claude-sonnet-5',
      },
    ],
    connections: [
      {
        id: 'browser',
        to: {
          type: 'browser',
        },
      },
    ],
  },
  {
    name: 'AguiAgent',
    description:
      'AG-UI-native AgentCore Runtime (issue #176) — emits AG-UI events directly (no Bedrock Converse translation) and persists turns to MyHarnessMemory.',
    build: 'Container',
    codeLocation: resolve(__dirname, 'AguiAgent') as DirectoryPath,
    dockerfile: 'Dockerfile',
    entrypoint: 'server.ts' as FilePath,
    protocol: 'AGUI',
    networkMode: 'PUBLIC',
    envVars: [
      {
        name: 'BEDROCK_MODEL_ID',
        value: 'us.anthropic.claude-sonnet-5',
      },
    ],
  },
];

export const policyEngines: PolicyEngine[] = [
  {
    // Cedar policy engine for default-gateway. Associated in ENFORCE mode
    // (#280) — tool calls are routed through the gateway (#279), so a group
    // without an ALLOW grant (or with an explicit DENY) for a tool is
    // actually blocked, not just logged. No static policies here: the
    // sync-cedar-policies Lambda (#272, web/amplify/functions/sync-cedar-policies)
    // generates and pushes Cedar policies directly via
    // CreatePolicy/UpdatePolicy/DeletePolicy whenever a GroupToolGrant row
    // changes (web/amplify/data/schemas/agentConfig.schema.ts), so this
    // array intentionally stays empty — the live policy set lives on the
    // deployed engine, not in this file.
    name: 'DefaultCedar',
    description: 'Cedar policy engine for default-gateway.',
    policies: [],
  },
];

// The base gateway spec, WITHOUT `authorizerType`/`authorizerConfiguration`/
// `resourceName` — backend.ts re-derives all three per-deployment (a live
// Cognito discoveryUrl/allowedClients, and a unique physical resourceName),
// so a placeholder here would just go stale.
type GatewayBaseSpec = Omit<
  AgentCoreMcpSpec['agentCoreGateways'][number],
  'authorizerType' | 'authorizerConfiguration' | 'resourceName'
>;

export const gateways: GatewayBaseSpec[] = [
  {
    name: 'default-gateway',
    description: 'Gateway for default-gateway',
    targets: [],
    enableSemanticSearch: true,
    exceptionLevel: 'DEBUG',
    policyEngineConfiguration: {
      policyEngineName: 'DefaultCedar',
      mode: 'ENFORCE',
    },
  },
];
