// Translates GroupToolGrant rows (web/amplify/data/schemas/agentConfig.schema.ts)
// into Cedar policies for the `DefaultCedar` policy engine associated with
// `default-gateway` (agent/default/agentcore/agentcore.json, added in #271).
//
// This module is pure/synchronous — no AWS SDK calls — so the mapping can be
// unit-tested without a live gateway. syncCedarPolicies (cedar-policy-sync.ts)
// calls generateCedarPolicies and pushes the result to the deployed policy
// engine via CreatePolicy/UpdatePolicy/DeletePolicy.
//
// Mapping contract (see docs/mcp-tool-permissions.md "Cedar policy engine"
// section, established in #271 and confirmed here in #272):
// - Principal: `principal is AgentCore::OAuthUser` guarded by
//   `principal.getTag("cognito:groups") like "*\"<group>\"*"`. AgentCore
//   surfaces every JWT claim as an OAuthUser tag, but — confirmed against a
//   live ENFORCE engine (#325) — it surfaces `cognito:groups` as the *JSON
//   string* of the claim array (e.g. `["reservoir-eng"]`), NOT as a Cedar
//   `Set<String>`. So the tag is String-typed: `.contains(...)` is rejected at
//   policy validation with "expected Set<...Any> but saw String" (UPDATE_FAILED,
//   the policy never goes ACTIVE, and ENFORCE then denies every call by
//   default). String matching is required instead, and `like` with the group
//   name wrapped in its surrounding JSON quotes (`"*\"<group>\"*"`) is the
//   delimiter-safe membership test — it matches the group as a distinct quoted
//   array element, so `reservoir-eng` cannot spuriously match
//   `reservoir-engineering`. (Cognito group names are limited to alphanumerics
//   plus `+=,.@_-`, none of which are Cedar `like` metacharacters, so the group
//   name needs no further escaping.)
// - Action: `AgentCore::Action::"<targetName>___<toolName>"` for an exact tool
//   grant (matching the CLI's own generated-policy action-naming convention —
//   see `agentcore add policy -g`). For the `"*"` wildcard toolName, Cedar has
//   no glob syntax for action ids — a literal `"<targetName>___*"` action does
//   not exist and fails policy validation (CREATE_FAILED under ENFORCE,
//   denying every tool on the target — see #358). Instead we enumerate the
//   target's concrete tool actions with `action in [ AgentCore::Action::"…",
//   … ]`, using the tool names threaded through via
//   `ToolGrantInput.targetToolNames` (populated from GetGatewayTarget's
//   `targetConfiguration.mcp.lambda.toolSchema.inlinePayload[].name` in the
//   sync handler). A wildcard grant with no resolvable tool names produces no
//   policy at all (see generateCedarPolicies) rather than an invalid one.
// - Resource: `resource == AgentCore::Gateway::"<gatewayArn>"`. AWS's Cedar
//   analyzer rejects an unconstrained `resource is AgentCore::Gateway` for any
//   constrained (non-bare) action — every action clause this module emits is
//   constrained (either an exact tool or a target-scoped wildcard, never a
//   bare `action`), so the resource must always be pinned to the concrete
//   gateway too. Confirmed against a live policy engine: CreatePolicy 400s
//   with "please constrain the resource to a specific AgentCore::Gateway
//   resource when creating tool-specific policies" otherwise — matches the
//   `agentcore` CLI's own Cedar synthesis (dRn in its guardrail-policy code),
//   which emits `resource == AgentCore::Gateway::"<gatewayArn>"` whenever the
//   action is target-scoped.
// - Effect: `DENY` -> Cedar `forbid`, `ALLOW` -> Cedar `permit`. Forbid always
//   wins over permit in Cedar, matching the DENY-over-ALLOW semantics
//   `web/lib/tool-permissions.ts` already implements client-side.

export type ToolGrantEffect = 'ALLOW' | 'DENY';

export interface ToolGrantInput {
  group: string;
  /** Gateway target name for this grant's MCP server (see resolveTargetName). */
  targetName: string;
  toolName: string;
  effect: ToolGrantEffect;
  /**
   * Concrete tool names available on this grant's target. Only used (and
   * required to produce a policy) when `toolName === '*'` — see the module
   * header comment on why Cedar can't express the wildcard as a literal
   * action.
   */
  targetToolNames?: string[];
}

export interface CedarPolicySpec {
  name: string;
  description: string;
  statement: string;
  validationMode: 'FAIL_ON_ANY_FINDINGS' | 'IGNORE_ALL_FINDINGS';
  enforcementMode: 'ACTIVE' | 'LOG_ONLY';
}

const POLICY_NAME_PREFIX = 'Grant';

/** Cedar policy names must start with a letter and be alphanumeric+underscore, max 48 chars (agentcore CLI's PolicyNameSchema). */
function sanitizePolicyNameSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * Deterministic, unique-per-(group, targetName, toolName) policy name. Reruns
 * of the sync produce the same name for the same grant, so syncCedarPolicies
 * can diff by name rather than recreating everything every time.
 */
export function cedarPolicyName(grant: ToolGrantInput): string {
  const raw = `${POLICY_NAME_PREFIX}_${grant.group}_${grant.targetName}_${grant.toolName === '*' ? 'ALL' : grant.toolName}`;
  const sanitized = sanitizePolicyNameSegment(raw);
  if (sanitized.length <= 48) return sanitized;
  // Deterministically shorten by hashing the overflowing tail rather than
  // truncating blindly, so two long-but-different grants don't collide.
  const hash = simpleHash(raw).toString(36);
  return `${sanitized.slice(0, 48 - 1 - hash.length)}_${hash}`;
}

function simpleHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** True for a wildcard grant with no tool names to enumerate — see generateCedarPolicies, which skips these rather than emitting an invalid statement. */
function isUngeneratableWildcard(grant: ToolGrantInput): boolean {
  return grant.toolName === '*' && !(grant.targetToolNames && grant.targetToolNames.length > 0);
}

function cedarAction(grant: ToolGrantInput): string {
  if (grant.toolName === '*') {
    const actions = (grant.targetToolNames ?? []).map(
      (toolName) => `AgentCore::Action::"${grant.targetName}___${toolName}"`,
    );
    return `action in [ ${actions.join(', ')} ]`;
  }
  const actionName = `${grant.targetName}___${grant.toolName}`;
  return `action == AgentCore::Action::"${actionName}"`;
}

function cedarStatement(grant: ToolGrantInput, gatewayArn: string): string {
  const effect = grant.effect === 'DENY' ? 'forbid' : 'permit';
  const action = cedarAction(grant);
  return [
    `${effect}(`,
    `  principal is AgentCore::OAuthUser,`,
    `  ${action},`,
    `  resource == AgentCore::Gateway::"${gatewayArn}"`,
    `)`,
    `when {`,
    `  principal.hasTag("cognito:groups") &&`,
    `  principal.getTag("cognito:groups") like "*\\"${grant.group}\\"*"`,
    `};`,
  ].join('\n');
}

/**
 * Translates GroupToolGrant rows into Cedar Policy specs for `DefaultCedar`.
 * One Cedar policy per grant row — no merging — so each policy maps back to
 * exactly one GroupToolGrant for auditability, and deleting a grant deletes
 * exactly one policy (see cedar-policy-sync.ts).
 *
 * DENY-over-ALLOW is enforced by Cedar itself (forbid always overrides
 * permit), not by this function — every grant becomes its own permit/forbid
 * policy, and Cedar's evaluator applies the precedence.
 *
 * A `"*"` toolName grant with no `targetToolNames` (the target's tool list
 * couldn't be resolved) produces no policy at all — there is no valid Cedar
 * action to emit for it, and the caller can safely retry once the target's
 * tools are resolvable again (see cedar-policy-sync.ts: an undesired policy
 * just gets deleted, which fails closed rather than leaving an invalid one).
 */
export function generateCedarPolicies(grants: ToolGrantInput[], gatewayArn: string): CedarPolicySpec[] {
  return grants
    .filter((grant) => !isUngeneratableWildcard(grant))
    .map((grant) => ({
      name: cedarPolicyName(grant),
      description:
        grant.toolName === '*'
          ? `${grant.effect} ${grant.group} -> all tools on gateway target ${grant.targetName} (GroupToolGrant, generated by #272 sync — do not hand-edit).`
          : `${grant.effect} ${grant.group} -> ${grant.targetName}.${grant.toolName} (GroupToolGrant, generated by #272 sync — do not hand-edit).`,
      statement: cedarStatement(grant, gatewayArn),
      validationMode: grant.effect === 'DENY' ? 'IGNORE_ALL_FINDINGS' : 'FAIL_ON_ANY_FINDINGS',
      // ACTIVE now that default-gateway's policy engine mode is ENFORCE (#280) —
      // this per-policy field is independent of the gateway-level mode, so both
      // must agree for a grant to actually block/allow a tool call.
      enforcementMode: 'ACTIVE',
    }));
}
