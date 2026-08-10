import { Construct } from 'constructs';
import { PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import type {
  AgentCoreApplication as AgentCoreApplicationType,
  AgentCoreMcp as AgentCoreMcpType,
  HarnessDeploymentConfig,
  HarnessSpec,
  Memory,
  AgentEnvSpec,
  AgentCoreProjectSpec,
  AgentCoreMcpSpec,
  PolicyEngine,
} from '@aws/agentcore-cdk';

// @aws/agentcore-cdk (alpha) only declares a "require" condition in its
// package.json exports map, so a static ESM `import` of its value bindings
// fails to resolve under Amplify's ESM bundling. Load it via createRequire,
// keeping the type imports above (which the compiler elides) for typing.
const require = createRequire(import.meta.url);
const {
  AgentCoreApplication: RealAgentCoreApplication,
  AgentCoreMcp,
  setSessionProjectRoot,
  toPascalId,
}: typeof import('@aws/agentcore-cdk') = require('@aws/agentcore-cdk');

// Both RealAgentCoreApplication (for its runtime/harness container builds) and
// AgentCoreMcp call the CLI's findConfigRoot(), which walks up from
// process.cwd() looking for an agentcore/ directory. Under `ampx sandbox` cwd
// is web/, not the repo root, so it never finds agent/default/agentcore — point
// it there explicitly (mirrors what `agentcore` CLI commands do after `init`).
// Runtime `codeLocation`s in agentcore.json resolve relative to the *parent* of
// this directory (agent/default/), so "app/ClaudeCode" → agent/default/app/ClaudeCode.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../../agent/default');
setSessionProjectRoot(projectRoot);

/**
 * A harness to deploy: the full validated `HarnessSpec` (model/tools/memory/… —
 * the `harness.json` shape) plus its config directory (`harnessDir`), which the
 * construct uses to auto-discover a `system-prompt.md` when `spec.systemPrompt`
 * is omitted.
 */
export interface HarnessDeployment {
  /** Full harness spec — creates the `AWS::BedrockAgentCore::Harness` resource. */
  spec: HarnessSpec;
  /**
   * Directory holding this harness's `system-prompt.md` (auto-discovered when
   * `spec.systemPrompt` is unset). Relative paths resolve from `agent/default/`.
   */
  harnessDir?: string;
}

export interface AgentCoreApplicationProps {
  /** Project name prefix used for physical resource names (matches agentcore.json `name`). */
  projectName: string;
  /** Memory resources to create (from agentcore.json `memories`). */
  memories: Memory[];
  /** Runtime (AgentCore Runtime) specs to create (from agentcore.json `runtimes`). */
  runtimes?: AgentEnvSpec[];
  /** Harnesses to create — full specs, inlined by the caller (see `HarnessDeployment`). */
  harnesses: HarnessDeployment[];
  /** Gateway/MCP spec (from agentcore.json `agentCoreGateways`), if any gateways are configured. */
  mcpSpec?: AgentCoreMcpSpec;
  /** Policy engines to create (from agentcore.json `policyEngines`), if any are configured. */
  policyEngines?: PolicyEngine[];
}

/**
 * Thin wrapper over the real `AgentCoreApplication` L3 construct from
 * `@aws/agentcore-cdk`, keeping the accessor-based API (`harnessArn`,
 * `memoryArn`, `gatewayArn`, `runtimeArn`, …) that `backend.ts` consumes so the
 * ARNs stay same-stack CDK tokens rather than values discovered post-deploy via
 * the `agentcore` CLI's control-plane API.
 *
 * The real `AgentCoreApplication` creates the **memories**, the **runtimes**
 * (AgentCore Runtimes — e.g. the ClaudeCode container agent, built via
 * CodeBuild → ECR), **policy engines** (Cedar, e.g. `DefaultCedar` from #271),
 * and — since @aws/agentcore-cdk 0.1.0-alpha.38 — each **harness**
 * (`AWS::BedrockAgentCore::Harness` + its execution role) when a full `spec`
 * is supplied. It does NOT create gateways, so those still come from the
 * separate `AgentCoreMcp` construct (which reads a gateway's
 * `policyEngineConfiguration.policyEngineName` back off this app's
 * `policyEngines` map to attach it — see @aws/agentcore-cdk's AgentCoreMcp).
 *
 * Harness/memory/runtime specs come from `agentcore.json` (memories/runtimes)
 * and `backend.ts` (harness specs, so the system prompt + Cognito authorizer
 * can be injected at synth). No `harness.json`/translation layer.
 */
export class AgentCoreApplication extends Construct {
  /** The underlying real L3 construct (memories, runtimes, harnesses + roles). */
  public readonly app: AgentCoreApplicationType;
  public readonly mcp?: AgentCoreMcpType;

  constructor(scope: Construct, id: string, props: AgentCoreApplicationProps) {
    super(scope, id);

    const { projectName } = props;

    // The app's `harnesses` prop is HarnessDeploymentConfig[] — role-scoped
    // fields (name/memoryName/tools/apiFormat, used to build the IAM role +
    // container) PLUS the full `spec` + `harnessDir` that trigger the CFN
    // harness resource. Derive the role config from each spec.
    const harnessConfigs: HarnessDeploymentConfig[] = props.harnesses.map(({ spec, harnessDir }) => ({
      name: spec.name,
      memoryName: spec.memory?.mode === 'existing' ? spec.memory.name : undefined,
      tools: spec.tools,
      skills: spec.skills,
      apiKeyArn: spec.model.apiKeyArn,
      apiFormat: spec.model.apiFormat,
      dockerfile: spec.dockerfile,
      containerUri: spec.containerUri,
      spec,
      harnessDir,
    }));

    // The real construct only reads name/tags/memories/runtimes/policyEngines
    // off this (see AgentCoreApplication.js), but AgentCoreProjectSpec's
    // inferred type requires every field with a Zod default (version,
    // managedBy, credentials, evaluators, onlineEvalConfigs,
    // agentCoreGateways) to be present, so they're set to their schema
    // defaults explicitly here instead of casting the object.
    const spec: AgentCoreProjectSpec = {
      name: projectName,
      version: 1,
      managedBy: 'CDK',
      memories: props.memories,
      runtimes: props.runtimes ?? [],
      policyEngines: props.policyEngines ?? [],
      credentials: [],
      evaluators: [],
      onlineEvalConfigs: [],
      agentCoreGateways: [],
    };

    this.app = new RealAgentCoreApplication(this, 'App', {
      spec,
      harnesses: harnessConfigs,
    });

    if (props.mcpSpec?.agentCoreGateways?.length) {
      this.mcp = new AgentCoreMcp(this, 'Mcp', {
        projectName,
        mcpSpec: props.mcpSpec,
        // Wire gateway URLs + IAM grants into the runtimes the real app created.
        agentCoreApplication: this.app,
      });
    }
  }

  /** ARN of a harness by its logical name (the `HarnessSpec.name` passed in), e.g. "MyHarness". */
  public harnessArn(name: string): string {
    const harness = this.app.harnesses.get(name);
    if (!harness) throw new Error(`Harness "${name}" not found in AgentCoreApplication`);
    return harness.harnessArn;
  }

  /** Execution role ARN of a harness by its logical name. */
  public harnessRoleArn(name: string): string {
    const role = this.app.harnessRoles.get(name);
    if (!role) throw new Error(`Harness "${name}" not found in AgentCoreApplication`);
    return role.roleArn;
  }

  /** ARN of an AgentCore Runtime by its logical name (the runtime `name` from agentcore.json), e.g. "ClaudeCode". */
  public runtimeArn(name: string): string {
    const env = this.app.environments.get(name);
    if (!env) throw new Error(`Runtime "${name}" not found in AgentCoreApplication`);
    return env.runtime.runtimeArn;
  }

  /** Id of an AgentCore Runtime by its logical name. */
  public runtimeId(name: string): string {
    const env = this.app.environments.get(name);
    if (!env) throw new Error(`Runtime "${name}" not found in AgentCoreApplication`);
    return env.runtime.runtimeId;
  }

  /**
   * Attach a policy statement to an AgentCore Runtime's execution role — the
   * role the container assumes at run time. Used to grant the ClaudeCode runtime
   * `states:SendTaskSuccess`/`SendTaskFailure` so it can resume the webhook
   * state machine's paused callback task (issue #175). Delegates to the real
   * runtime construct's `addToPolicy` (a no-op with a synth warning for imported
   * roles, per @aws/agentcore-cdk).
   */
  public addRuntimeRolePolicy(name: string, statement: PolicyStatement): void {
    const env = this.app.environments.get(name);
    if (!env) throw new Error(`Runtime "${name}" not found in AgentCoreApplication`);
    env.runtime.addToPolicy(statement);
  }

  /**
   * Set an environment variable on an AgentCore Runtime's container (merges with
   * any envVars already declared in agentcore.json). Used to hand the ClaudeCode
   * runtime the memory id/region — resolved post-synth from the same-stack
   * `AgentCoreMemory` construct, so it can't be hardcoded in agentcore.json.
   */
  public addRuntimeEnvironmentVariable(name: string, key: string, value: string): void {
    const env = this.app.environments.get(name);
    if (!env) throw new Error(`Runtime "${name}" not found in AgentCoreApplication`);
    env.runtime.addEnvironmentVariable(key, value);
  }

  /**
   * The IAM execution role of a Gateway, by its logical name.
   *
   * `AgentCoreMcp.gateways` only exposes the L1 `CfnGateway` (no `.role`), so
   * this reaches the internal `Gateway` component construct — stored as a
   * child of the `Mcp` construct under the same `toPascalId('Gateway', name)`
   * logical id `AgentCoreMcp` uses internally — and returns its `.role`.
   *
   * Callers need this to grant the gateway role identity-based permissions
   * (e.g. `lambda:InvokeFunction` on a Lambda target). The `Gateway` component
   * only auto-grants that when it creates a Lambda target itself (inline
   * `agentCoreGateways[].targets[]` in agentcore.json); targets registered
   * out-of-band via a custom resource (e.g. `S3ToolsGatewayTarget`) never go
   * through that path, so the grant must be added explicitly — the
   * resource-based Lambda permission (`AllowGatewayInvoke`) alone is not
   * sufficient; `CreateGatewayTarget` synchronously validates both.
   *
   * IMPORTANT — attach the grant in the SAME stack that owns the target Lambda
   * ARN (the sink stack), NOT here in the agent stack. The gateway role lives
   * in the agent stack; adding a statement that references a function-stack
   * token (the Lambda ARN) to the role's inline policy makes the agent stack
   * depend on the function stack, and the function stack already depends on
   * the agent stack (its Lambdas read `AGENTCORE_*` env vars) — a CFN cycle.
   * Instead create a standalone `iam.Policy` in the sink stack and attach it
   * to this role via `role.attachInlinePolicy(...)`.
   */
  public gatewayRole(name: string): IRole {
    if (!this.mcp) throw new Error(`Gateway "${name}" not found in AgentCoreApplication (no gateways configured)`);
    const gatewayComponent = this.mcp.node.findChild(toPascalId('Gateway', name)) as unknown as { role: IRole };
    return gatewayComponent.role;
  }

  public memoryArn(name: string): string {
    const memory = this.app.memories.get(name);
    if (!memory) throw new Error(`Memory "${name}" not found in AgentCoreApplication`);
    return memory.memoryArn;
  }

  public memoryId(name: string): string {
    const memory = this.app.memories.get(name);
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

  /** ARN of a policy engine by its logical name (the `PolicyEngine.name` from agentcore.json), e.g. "DefaultCedar". */
  public policyEngineArn(name: string): string {
    const policyEngine = this.app.policyEngines.get(name);
    if (!policyEngine) throw new Error(`Policy engine "${name}" not found in AgentCoreApplication`);
    return policyEngine.policyEngineArn;
  }

  /** Id of a policy engine by its logical name. */
  public policyEngineId(name: string): string {
    const policyEngine = this.app.policyEngines.get(name);
    if (!policyEngine) throw new Error(`Policy engine "${name}" not found in AgentCoreApplication`);
    return policyEngine.policyEngineId;
  }

  public gatewayEndpoint(name: string): string {
    const gateway = this.mcp?.gateways.get(name);
    if (!gateway) throw new Error(`Gateway "${name}" not found in AgentCoreApplication`);
    return gateway.attrGatewayUrl;
  }
}
