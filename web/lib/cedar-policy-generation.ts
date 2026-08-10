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
//   `principal.getTag("cognito:groups").contains("<group>")`. Cognito's
//   `cognito:groups` claim is a JSON array of group-name strings (confirmed
//   against AWS's documented ID-token payload shape), not a delimited string
//   as the #271 placeholder speculated — AgentCore surfaces every JWT claim as
//   an OAuthUser tag verbatim, so the tag value is a Cedar Set<String> and
//   `.contains(...)` is the correct membership check (not `like`).
// - Action: `AgentCore::Action::"<targetName>___<toolName>"` for an exact tool
//   grant (matching the CLI's own generated-policy action-naming convention —
//   see `agentcore add policy -g`); a bare `action` (unconstrained) for the
//   `"*"` wildcard toolName.
// - Resource: `resource is AgentCore::Gateway` (agentcore.json currently
//   configures exactly one gateway per engine; no per-resource distinction is
//   needed yet).
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

function cedarAction(grant: ToolGrantInput): string {
  if (grant.toolName === '*') return `action == AgentCore::Action::"${grant.targetName}___*"`;
  const actionName = `${grant.targetName}___${grant.toolName}`;
  return `action == AgentCore::Action::"${actionName}"`;
}

function cedarStatement(grant: ToolGrantInput): string {
  const effect = grant.effect === 'DENY' ? 'forbid' : 'permit';
  const action = cedarAction(grant);
  return [
    `${effect}(`,
    `  principal is AgentCore::OAuthUser,`,
    `  ${action},`,
    `  resource is AgentCore::Gateway`,
    `)`,
    `when {`,
    `  principal.hasTag("cognito:groups") &&`,
    `  principal.getTag("cognito:groups").contains("${grant.group}")`,
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
 */
export function generateCedarPolicies(grants: ToolGrantInput[]): CedarPolicySpec[] {
  return grants.map((grant) => ({
    name: cedarPolicyName(grant),
    description:
      grant.toolName === '*'
        ? `${grant.effect} ${grant.group} -> all tools on gateway target ${grant.targetName} (GroupToolGrant, generated by #272 sync — do not hand-edit).`
        : `${grant.effect} ${grant.group} -> ${grant.targetName}.${grant.toolName} (GroupToolGrant, generated by #272 sync — do not hand-edit).`,
    statement: cedarStatement(grant),
    validationMode: 'FAIL_ON_ANY_FINDINGS',
    // ACTIVE now that default-gateway's policy engine mode is ENFORCE (#280) —
    // this per-policy field is independent of the gateway-level mode, so both
    // must agree for a grant to actually block/allow a tool call.
    enforcementMode: 'ACTIVE',
  }));
}
