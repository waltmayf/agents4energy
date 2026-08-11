import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCedarPolicies,
  cedarPolicyName,
  type ToolGrantInput,
} from './cedar-policy-generation.ts';

const TEST_GATEWAY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/test-gateway-abc123';

function grant(overrides: Partial<ToolGrantInput> = {}): ToolGrantInput {
  return {
    group: 'admin',
    targetName: 'reservoir-target',
    toolName: 'get_well_data',
    effect: 'ALLOW',
    ...overrides,
  };
}

test('ALLOW grant on an exact tool becomes a permit policy scoped to that action', () => {
  const [policy] = generateCedarPolicies([grant()], TEST_GATEWAY_ARN);
  assert.match(policy.statement, /^permit\(/);
  assert.match(policy.statement, /action == AgentCore::Action::"reservoir-target___get_well_data"/);
  assert.match(policy.statement, new RegExp(`resource == AgentCore::Gateway::"${TEST_GATEWAY_ARN}"`));
  assert.match(policy.statement, /principal is AgentCore::OAuthUser/);
});

test('DENY grant becomes a forbid policy, not permit', () => {
  const [policy] = generateCedarPolicies([grant({ effect: 'DENY' })], TEST_GATEWAY_ARN);
  assert.match(policy.statement, /^forbid\(/);
  assert.doesNotMatch(policy.statement, /^permit\(/);
});

test('"*" toolName maps to a target-scoped action (ensuring only its own tools are authorized)', () => {
  const [policy] = generateCedarPolicies([grant({ toolName: '*' })], TEST_GATEWAY_ARN);
  // The action clause should be scoped to the target name, not a generic bare action.
  assert.match(policy.statement, /action == AgentCore::Action::"reservoir-target___\*"/);
  assert.doesNotMatch(policy.statement, /,\n\s*action,\n/);
});

test('the principal check string-matches the cognito:groups tag with a quote-delimited `like` (the tag is a JSON-array string, not a Cedar Set — #325)', () => {
  const [policy] = generateCedarPolicies([grant({ group: 'reservoir-eng' })], TEST_GATEWAY_ARN);
  // AgentCore surfaces cognito:groups as the JSON string of the claim array
  // (e.g. `["reservoir-eng"]`), so it is String-typed: `.contains(...)` is a
  // Set op and fails policy validation ("expected Set but saw String"), leaving
  // the policy UPDATE_FAILED and ENFORCE denying by default. Use `like` on the
  // group wrapped in its surrounding JSON quotes so it matches a distinct array
  // element (delimiter-safe: `reservoir-eng` must not match `reservoir-engineering`).
  assert.match(policy.statement, /principal\.getTag\("cognito:groups"\) like "\*\\"reservoir-eng\\"\*"/);
  assert.doesNotMatch(policy.statement, /\.contains\(/);
});

test('the `like` pattern is delimiter-safe — a group name is not a prefix-match of a longer group', () => {
  const [policy] = generateCedarPolicies([grant({ group: 'reservoir-eng' })], TEST_GATEWAY_ARN);
  // The quotes around the group name in the pattern ensure `["reservoir-engineering"]`
  // does NOT satisfy a policy granted to `reservoir-eng`.
  assert.ok(
    policy.statement.includes('like "*\\"reservoir-eng\\"*"'),
    `expected quote-delimited like pattern, got: ${policy.statement}`,
  );
});

test('every generated policy is ACTIVE (matches the engine-level ENFORCE mode, #280)', () => {
  for (const policy of generateCedarPolicies(
    [grant(), grant({ effect: 'DENY' }), grant({ toolName: '*' })],
    TEST_GATEWAY_ARN,
  )) {
    assert.equal(policy.enforcementMode, 'ACTIVE');
  }
});

test('policy names are deterministic and stable across repeated calls for the same grant', () => {
  const g = grant({ group: 'drilling', targetName: 'ops-target', toolName: 'spud_well' });
  assert.equal(cedarPolicyName(g), cedarPolicyName({ ...g }));
});

test('policy names are unique across different groups/targets/tools for the same base grant', () => {
  const names = new Set(
    generateCedarPolicies(
      [
        grant({ group: 'admin' }),
        grant({ group: 'drilling' }),
        grant({ targetName: 'other-target' }),
        grant({ toolName: 'other_tool' }),
        grant({ toolName: '*' }),
      ],
      TEST_GATEWAY_ARN,
    ).map((p) => p.name),
  );
  assert.equal(names.size, 5);
});
test('"*" grant for target A does not authorize tools on target B', () => {
  const grantA = grant({ toolName: '*', targetName: 'target-A' });
  const policyA = generateCedarPolicies([grantA], TEST_GATEWAY_ARN)[0];
  // Action should be scoped to target-A
  assert.match(policyA.statement, /action == AgentCore::Action::"target-A___\*"/);
  // Ensure it does not contain target-B pattern
  assert.doesNotMatch(policyA.statement, /target-B___\*/);
});


test('policy names satisfy the agentcore CLI PolicyNameSchema (starts with a letter, alnum+underscore, <=48 chars)', () => {
  const longGrant = grant({
    group: 'a-very-long-cognito-group-name-that-goes-on',
    targetName: 'an-extremely-long-gateway-target-name-here',
    toolName: 'a_correspondingly_long_tool_name_for_good_measure',
  });
  const name = cedarPolicyName(longGrant);
  assert.ok(name.length <= 48, `expected <=48 chars, got ${name.length}: ${name}`);
  assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
});

test('DENY and ALLOW for the same (group, target, tool) produce two distinct policies, both present — Cedar itself resolves forbid-wins at evaluation time, not the generator', () => {
  const policies = generateCedarPolicies([grant({ effect: 'ALLOW' }), grant({ effect: 'DENY' })], TEST_GATEWAY_ARN);
  assert.equal(policies.length, 2);
  assert.ok(policies.some((p) => p.statement.startsWith('permit(')));
  assert.ok(policies.some((p) => p.statement.startsWith('forbid(')));
});

test('description documents the grant and flags the policy as generated (not hand-editable)', () => {
  const [policy] = generateCedarPolicies([grant()], TEST_GATEWAY_ARN);
  assert.match(policy.description, /admin/);
  assert.match(policy.description, /reservoir-target/);
  assert.match(policy.description, /get_well_data/);
  assert.match(policy.description, /generated by #272 sync/);
});
