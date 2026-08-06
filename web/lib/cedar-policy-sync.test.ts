import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncCedarPolicies, type PolicyEngineClient, type ExistingPolicySummary } from './cedar-policy-sync.ts';
import type { CedarPolicySpec } from './cedar-policy-generation.ts';

function policy(name: string, overrides: Partial<CedarPolicySpec> = {}): CedarPolicySpec {
  return {
    name,
    description: `desc for ${name}`,
    statement: `permit(principal, action, resource);`,
    validationMode: 'FAIL_ON_ANY_FINDINGS',
    enforcementMode: 'LOG_ONLY',
    ...overrides,
  };
}

class FakePolicyEngineClient implements PolicyEngineClient {
  policies: Map<string, ExistingPolicySummary>;
  calls: { created: string[]; updated: string[]; deleted: string[] } = {
    created: [],
    updated: [],
    deleted: [],
  };
  private nextId = 1;

  constructor(initial: ExistingPolicySummary[] = []) {
    this.policies = new Map(initial.map((p) => [p.name, p]));
  }

  async listPolicies(): Promise<ExistingPolicySummary[]> {
    return [...this.policies.values()];
  }

  async createPolicy(_engineId: string, policySpec: CedarPolicySpec): Promise<void> {
    this.policies.set(policySpec.name, { name: policySpec.name, policyId: `id-${this.nextId++}` });
    this.calls.created.push(policySpec.name);
  }

  async updatePolicy(_engineId: string, _policyId: string, policySpec: CedarPolicySpec): Promise<void> {
    this.calls.updated.push(policySpec.name);
  }

  async deletePolicy(_engineId: string, policyId: string): Promise<void> {
    const entry = [...this.policies.entries()].find(([, v]) => v.policyId === policyId);
    if (entry) this.policies.delete(entry[0]);
    this.calls.deleted.push(policyId);
  }
}

test('creates every desired policy when the engine starts empty', async () => {
  const client = new FakePolicyEngineClient();
  const result = await syncCedarPolicies(client, 'engine-1', [policy('Grant_admin_target_tool')]);
  assert.deepEqual(result.created, ['Grant_admin_target_tool']);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.deleted, []);
});

test('updates a policy that already exists on the engine rather than recreating it', async () => {
  const client = new FakePolicyEngineClient([{ name: 'Grant_admin_target_tool', policyId: 'p-1' }]);
  const result = await syncCedarPolicies(client, 'engine-1', [policy('Grant_admin_target_tool')]);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.updated, ['Grant_admin_target_tool']);
  assert.deepEqual(client.calls.updated, ['Grant_admin_target_tool']);
});

test('deletes a generated policy whose grant no longer exists (removed from desired)', async () => {
  const client = new FakePolicyEngineClient([
    { name: 'Grant_admin_target_tool', policyId: 'p-1' },
    { name: 'Grant_drilling_target_other_tool', policyId: 'p-2' },
  ]);
  const result = await syncCedarPolicies(client, 'engine-1', [policy('Grant_admin_target_tool')]);
  assert.deepEqual(result.deleted, ['Grant_drilling_target_other_tool']);
  assert.equal(client.policies.has('Grant_drilling_target_other_tool'), false);
  assert.equal(client.policies.has('Grant_admin_target_tool'), true);
});

test('never deletes a hand-written (non "Grant_"-prefixed) policy even when it is not in desired', async () => {
  const client = new FakePolicyEngineClient([
    { name: 'AdminAllowAllTools', policyId: 'p-hand-written' },
    { name: 'DefaultDenyUnauthenticated', policyId: 'p-hand-written-2' },
  ]);
  const result = await syncCedarPolicies(client, 'engine-1', [policy('Grant_admin_target_tool')]);
  assert.deepEqual(result.deleted, []);
  assert.equal(client.policies.has('AdminAllowAllTools'), true);
  assert.equal(client.policies.has('DefaultDenyUnauthenticated'), true);
});

test('a full reconcile — create one, update one, delete one — in a single sync call', async () => {
  const client = new FakePolicyEngineClient([
    { name: 'Grant_admin_target_tool', policyId: 'p-1' }, // stays, gets updated
    { name: 'Grant_drilling_target_stale_tool', policyId: 'p-2' }, // removed
  ]);
  const desired = [
    policy('Grant_admin_target_tool'),
    policy('Grant_reservoir-eng_target_new_tool'), // new
  ];
  const result = await syncCedarPolicies(client, 'engine-1', desired);
  assert.deepEqual(result.created, ['Grant_reservoir-eng_target_new_tool']);
  assert.deepEqual(result.updated, ['Grant_admin_target_tool']);
  assert.deepEqual(result.deleted, ['Grant_drilling_target_stale_tool']);
});

test('an empty desired list deletes all previously generated policies but leaves hand-written ones', async () => {
  const client = new FakePolicyEngineClient([
    { name: 'Grant_admin_target_tool', policyId: 'p-1' },
    { name: 'AdminAllowAllTools', policyId: 'p-hand-written' },
  ]);
  const result = await syncCedarPolicies(client, 'engine-1', []);
  assert.deepEqual(result.deleted, ['Grant_admin_target_tool']);
  assert.equal(client.policies.has('AdminAllowAllTools'), true);
});
