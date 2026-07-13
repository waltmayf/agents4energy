import { Construct } from 'constructs';
import { aws_bedrockagentcore as bedrock_agent_core, aws_iam as iam } from 'aws-cdk-lib';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import type {
  AgentCoreMemory as AgentCoreMemoryType,
  AgentCoreHarnessRole as AgentCoreHarnessRoleType,
  AgentCoreMcp as AgentCoreMcpType,
  HarnessRoleConfig,
  Memory,
  AgentCoreMcpSpec,
} from '@aws/agentcore-cdk';

// @aws/agentcore-cdk (alpha) only declares a "require" condition in its
// package.json exports map, so a static ESM `import` of its value bindings
// fails to resolve under Amplify's ESM bundling. Load it via createRequire,
// keeping the type imports above (which the compiler elides) for typing.
const require = createRequire(import.meta.url);
const {
  AgentCoreMemory,
  AgentCoreHarnessRole,
  AgentCoreMcp,
  setSessionProjectRoot,
}: typeof import('@aws/agentcore-cdk') = require('@aws/agentcore-cdk');

// AgentCoreMcp's constructor calls the CLI's findConfigRoot(), which walks up
// from process.cwd() looking for an agentcore/ directory. Under `ampx sandbox`
// cwd is web/, not the repo root, so it never finds agent/default/agentcore —
// point it there explicitly (mirrors what `agentcore` CLI commands do after `init`).
const __dirname = dirname(fileURLToPath(import.meta.url));
setSessionProjectRoot(resolve(__dirname, '../../../agent/default'));

/**
 * Harness spec whose `model`/`tools`/`memory`/`truncation`/`authorizerConfiguration`
 * fields are passed straight through to `CfnHarnessProps` with no translation —
 * callers construct these using the same nested property shapes CloudFormation
 * expects (`bedrock_agent_core.CfnHarness.*Property`). The handful of fields below
 * that aren't literal `CfnHarnessProps` sub-shapes exist only because they can't
 * be: `memoryName` refers to a memory created elsewhere in this construct (its
 * ARN is a CDK token that doesn't exist until that construct is created), and
 * `apiFormat` is IAM-role-only metadata with no CfnHarness counterpart.
 */
export interface HarnessSpec {
  /** Logical name — the physical CfnHarness name becomes `${projectName}_${name}`. */
  name: string;
  /** Passed directly as `CfnHarnessProps.model`. */
  model: bedrock_agent_core.CfnHarness.HarnessModelConfigurationProperty;
  /** Bedrock Mantle API format `model` uses — needed only for IAM role scoping, not a CfnHarness field. */
  apiFormat?: 'converse_stream' | 'responses' | 'chat_completions';
  /** API key ARN used by `model.openAiModelConfig`/`geminiModelConfig` — duplicated here (rather than read off `model`) only for IAM role scoping. */
  apiKeyArn?: string;
  /** Wrapped as `CfnHarnessProps.systemPrompt: [{ text: systemPrompt }]`. */
  systemPrompt?: string;
  /**
   * Passed directly as `CfnHarnessProps.tools`. `name` is required here (unlike
   * the underlying `HarnessToolProperty`, which marks it optional per the raw
   * CFN schema) since `AgentCoreHarnessRole` needs it for IAM policy scoping.
   */
  tools?: Array<bedrock_agent_core.CfnHarness.HarnessToolProperty & { name: string }>;
  /** Logical name of a memory in `AgentCoreApplicationProps.memories`, resolved to its ARN for `CfnHarnessProps.memory`. */
  memoryName?: string;
  memoryActorId?: string;
  /** Passed directly as `CfnHarnessProps.truncation`. */
  truncation?: bedrock_agent_core.CfnHarness.HarnessTruncationConfigurationProperty;
  /** Passed directly as `CfnHarnessProps.authorizerConfiguration`. */
  authorizerConfiguration?: bedrock_agent_core.CfnHarness.AuthorizerConfigurationProperty;
}

export interface AgentCoreApplicationProps {
  /** Project name prefix used for physical resource names (matches agentcore.json `name`). */
  projectName: string;
  /** Memory resources to create (from agentcore.json `memories`). */
  memories: Memory[];
  /** Harness specs, inlined by the caller — see `HarnessSpec`. */
  harnesses: HarnessSpec[];
  /** Gateway/MCP spec (from agentcore.json `agentCoreGateways`), if any gateways are configured. */
  mcpSpec?: AgentCoreMcpSpec;
}

/**
 * Builds the AgentCore harness/memory/gateway resources directly inside the Amplify
 * CDK app so their ARNs are same-stack tokens instead of values discovered post-deploy
 * via the `agentcore` CLI's control-plane API. Harness specs are inlined literally by
 * the caller (`backend.ts`) as `CfnHarness`-shaped objects — no `harness.json`/
 * translation layer. Memories/gateways still come from `agentcore.json`. Excludes
 * the `AgUiHandler` runtime (owned by `AgentCoreRuntimeWithBuild` to avoid a
 * duplicate CfnRuntime).
 */
export class AgentCoreApplication extends Construct {
  public readonly memories: Map<string, AgentCoreMemoryType> = new Map();
  public readonly harnesses: Map<string, { harness: bedrock_agent_core.CfnHarness; role: AgentCoreHarnessRoleType }> = new Map();
  public readonly mcp?: AgentCoreMcpType;

  constructor(scope: Construct, id: string, props: AgentCoreApplicationProps) {
    super(scope, id);

    const { projectName } = props;

    for (const memorySpec of props.memories) {
      const memory = new AgentCoreMemory(this, `Memory${memorySpec.name}`, {
        projectName,
        memory: memorySpec,
      });
      this.memories.set(memorySpec.name, memory);
    }

    for (const harnessSpec of props.harnesses) {
      const memory = harnessSpec.memoryName ? this.memories.get(harnessSpec.memoryName) : undefined;

      const roleConfig: HarnessRoleConfig = {
        name: harnessSpec.name,
        memoryName: harnessSpec.memoryName,
        tools: harnessSpec.tools,
        apiKeyArn: harnessSpec.apiKeyArn,
        apiFormat: harnessSpec.apiFormat,
      };

      const role = new AgentCoreHarnessRole(this, `HarnessRole${harnessSpec.name}`, {
        projectName,
        harness: roleConfig,
      });

      if (memory) {
        role.addToPolicy(
          new iam.PolicyStatement({
            actions: [
              'bedrock-agentcore:ListMemoryRecords',
              'bedrock-agentcore:RetrieveMemoryRecords',
              'bedrock-agentcore:GetEvent',
              'bedrock-agentcore:GetMemory',
              'bedrock-agentcore:GetMemoryRecord',
              'bedrock-agentcore:ListActors',
              'bedrock-agentcore:ListEvents',
              'bedrock-agentcore:ListSessions',
              'bedrock-agentcore:CreateEvent',
              'bedrock-agentcore:DeleteEvent',
              'bedrock-agentcore:DeleteMemoryRecord',
            ],
            resources: [memory.memoryArn],
          }),
        );
      }

      const harness = new bedrock_agent_core.CfnHarness(this, `Harness${harnessSpec.name}`, {
        harnessName: `${projectName}_${harnessSpec.name}`,
        executionRoleArn: role.roleArn,
        model: harnessSpec.model,
        systemPrompt: harnessSpec.systemPrompt ? [{ text: harnessSpec.systemPrompt }] : undefined,
        tools: harnessSpec.tools,
        memory: memory
          ? {
              agentCoreMemoryConfiguration: {
                arn: memory.memoryArn,
                actorId: harnessSpec.memoryActorId,
              },
            }
          : undefined,
        truncation: harnessSpec.truncation,
        authorizerConfiguration: harnessSpec.authorizerConfiguration,
      });

      harness.node.addDependency(role);

      this.harnesses.set(harnessSpec.name, { harness, role });
    }

    if (props.mcpSpec?.agentCoreGateways?.length) {
      this.mcp = new AgentCoreMcp(this, 'Mcp', {
        projectName,
        mcpSpec: props.mcpSpec,
      });
    }
  }

  /** ARN of a harness by its logical name (the `HarnessSpec.name` passed in), e.g. "MyHarness". */
  public harnessArn(name: string): string {
    const entry = this.harnesses.get(name);
    if (!entry) throw new Error(`Harness "${name}" not found in AgentCoreApplication`);
    return entry.harness.attrArn;
  }

  /** Execution role ARN of a harness by its logical name. */
  public harnessRoleArn(name: string): string {
    const entry = this.harnesses.get(name);
    if (!entry) throw new Error(`Harness "${name}" not found in AgentCoreApplication`);
    return entry.role.roleArn;
  }

  public memoryArn(name: string): string {
    const memory = this.memories.get(name);
    if (!memory) throw new Error(`Memory "${name}" not found in AgentCoreApplication`);
    return memory.memoryArn;
  }

  public memoryId(name: string): string {
    const memory = this.memories.get(name);
    if (!memory) throw new Error(`Memory "${name}" not found in AgentCoreApplication`);
    return memory.memoryId;
  }

  public gatewayArn(name: string): string {
    const gateway = this.mcp?.gateways.get(name);
    if (!gateway) throw new Error(`Gateway "${name}" not found in AgentCoreApplication`);
    return gateway.attrGatewayArn;
  }

  public gatewayId(name: string): string {
    const gateway = this.mcp?.gateways.get(name);
    if (!gateway) throw new Error(`Gateway "${name}" not found in AgentCoreApplication`);
    return gateway.attrGatewayIdentifier;
  }

  public gatewayEndpoint(name: string): string {
    const gateway = this.mcp?.gateways.get(name);
    if (!gateway) throw new Error(`Gateway "${name}" not found in AgentCoreApplication`);
    return gateway.attrGatewayUrl;
  }
}
