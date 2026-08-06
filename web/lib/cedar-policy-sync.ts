// Pushes generateCedarPolicies' output (cedar-policy-generation.ts) to a
// deployed AgentCore Cedar policy engine (DefaultCedar, #271) by diffing
// against ListPolicies and calling Create/Update/DeletePolicy. Decoupled from
// the AWS SDK behind a small client interface (PolicyEngineClient) so the diff
// logic is unit-testable without a live gateway.
//
// Every generated policy's name is deterministic (cedarPolicyName) and
// prefixed "Grant_" — this sync only ever creates/updates/deletes policies it
// generated itself. It never touches a hand-written policy (e.g. a future
// non-generated policy an admin adds directly), because those won't match the
// "Grant_" naming convention and so never appear in `desired`.

import type { CedarPolicySpec } from './cedar-policy-generation';

export interface ExistingPolicySummary {
  name: string;
  policyId: string;
}

/** The subset of BedrockAgentCoreControlClient operations syncCedarPolicies needs. */
export interface PolicyEngineClient {
  listPolicies(policyEngineId: string): Promise<ExistingPolicySummary[]>;
  createPolicy(policyEngineId: string, policy: CedarPolicySpec): Promise<void>;
  updatePolicy(policyEngineId: string, policyId: string, policy: CedarPolicySpec): Promise<void>;
  deletePolicy(policyEngineId: string, policyId: string): Promise<void>;
}

const GENERATED_POLICY_PREFIX = 'Grant_';

export interface SyncResult {
  created: string[];
  updated: string[];
  deleted: string[];
}

/**
 * Reconciles the policy engine's generated ("Grant_"-prefixed) policies with
 * `desired`. Policies are keyed by name (cedarPolicyName is deterministic, so
 * the same grant always maps to the same policy name across syncs):
 * - name in desired, not on engine -> CreatePolicy
 * - name in desired, on engine with a different statement/enforcementMode ->
 *   UpdatePolicy
 * - name in desired, on engine, unchanged -> no-op
 * - "Grant_"-prefixed name on engine, not in desired -> DeletePolicy (the
 *   underlying grant was removed or edited into a different toolName/effect)
 *
 * Non-"Grant_" policies (hand-written, e.g. a future admin-authored policy)
 * are never listed as candidates for deletion — only ones this sync itself
 * could have created are touched.
 */
export async function syncCedarPolicies(
  client: PolicyEngineClient,
  policyEngineId: string,
  desired: CedarPolicySpec[],
): Promise<SyncResult> {
  const existing = await client.listPolicies(policyEngineId);
  const existingByName = new Map(existing.map((p) => [p.name, p]));
  const desiredNames = new Set(desired.map((p) => p.name));

  const result: SyncResult = { created: [], updated: [], deleted: [] };

  for (const policy of desired) {
    const current = existingByName.get(policy.name);
    if (!current) {
      await client.createPolicy(policyEngineId, policy);
      result.created.push(policy.name);
      continue;
    }
    // We only have the policy's identity from ListPolicies (no statement/mode
    // in the summary) — always push Update. AgentCore's UpdatePolicy is
    // idempotent for identical content, so a no-op update costs an API call
    // but not correctness; comparing content would require GetPolicy per
    // existing policy every sync, which is worse for the common case where
    // most policies are already up to date.
    await client.updatePolicy(policyEngineId, current.policyId, policy);
    result.updated.push(policy.name);
  }

  for (const existingPolicy of existing) {
    if (existingPolicy.name.startsWith(GENERATED_POLICY_PREFIX) && !desiredNames.has(existingPolicy.name)) {
      await client.deletePolicy(policyEngineId, existingPolicy.policyId);
      result.deleted.push(existingPolicy.name);
    }
  }

  return result;
}
