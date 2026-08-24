// Unit tests for the self-supersession guard (issue #494) — see handler.ts's
// comment-mention branch for how this stops an own-App @agentcore-claude
// mention from cancelling a RUNNING execution for the same issue/PR. The SFN
// client is a stub object, so this runs offline with no AWS credentials/network.
//
// Run: cd web && node --test --experimental-strip-types \
//   amplify/functions/agent-webhook-receiver/hasRunningExecution.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SFNClient } from '@aws-sdk/client-sfn';
import { hasRunningExecution } from './hasRunningExecution.ts';

type StubClient = Pick<SFNClient, 'send'>;

function stubSfn(send: StubClient['send']): StubClient {
  return { send };
}

test('returns false immediately when stateMachineArn is empty (no ListExecutions call)', async () => {
  let calls = 0;
  const sfn = stubSfn((async () => { calls += 1; return { executions: [] }; }) as StubClient['send']);
  assert.equal(await hasRunningExecution(sfn as SFNClient, '', 'github-owner-repo-34-'), false);
  assert.equal(calls, 0);
});

test('returns true when a RUNNING execution matches the prefix', async () => {
  const sfn = stubSfn((async () => ({
    executions: [{ executionArn: 'arn:...:e1', name: 'github-owner-repo-34-abcdef' }],
  })) as StubClient['send']);
  assert.equal(await hasRunningExecution(sfn as SFNClient, 'arn:aws:states:us-east-1:111111111111:stateMachine:test', 'github-owner-repo-34-'), true);
});

test('returns false when no RUNNING execution matches the prefix', async () => {
  const sfn = stubSfn((async () => ({
    executions: [{ executionArn: 'arn:...:e1', name: 'github-owner-repo-99-abcdef' }],
  })) as StubClient['send']);
  assert.equal(await hasRunningExecution(sfn as SFNClient, 'arn:aws:states:us-east-1:111111111111:stateMachine:test', 'github-owner-repo-34-'), false);
});

test('follows nextToken pagination before concluding false', async () => {
  let calls = 0;
  const sfn = stubSfn((async () => {
    calls += 1;
    if (calls === 1) return { executions: [{ executionArn: 'arn:...:e1', name: 'other-prefix-1' }], nextToken: 'page-2' };
    return { executions: [{ executionArn: 'arn:...:e2', name: 'github-owner-repo-34-xyz' }] };
  }) as StubClient['send']);
  assert.equal(await hasRunningExecution(sfn as SFNClient, 'arn:aws:states:us-east-1:111111111111:stateMachine:test', 'github-owner-repo-34-'), true);
  assert.equal(calls, 2);
});

test('swallows ListExecutions failures and returns false', async () => {
  const sfn = stubSfn((async () => { throw new Error('AccessDenied'); }) as StubClient['send']);
  assert.equal(await hasRunningExecution(sfn as SFNClient, 'arn:aws:states:us-east-1:111111111111:stateMachine:test', 'github-owner-repo-34-'), false);
});
