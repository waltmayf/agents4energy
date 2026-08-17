// Unit test for the monitor-loop expiry fix (issue #425): a `maxIterations`
// timeout used to be a terminal state (PostMonitorStoppedComment posted a
// comment and the execution ended there, leaving nothing to drive the epic
// forward — see docs/monitor-loop.md and docs/autonomous-epic-delivery.md).
// This asserts the synthesized state machine now chains that state into a
// re-invoke instead of leaving it as a dead end.
//
// Run: cd web && node --test --experimental-strip-types amplify/constructs/agentWebhookStack.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AgentWebhookStack } from './agentWebhookStack.ts';

function synthStateMachine() {
  const app = new App();
  const stack = new Stack(app, 'TestStack');

  // Imported (ARN-only) functions are enough here — the assertions below only
  // inspect the state machine's own Definition, not the Lambdas' own resources.
  const fn = (id: string) =>
    lambda.Function.fromFunctionArn(stack, id, `arn:aws:lambda:us-east-1:123456789012:function:${id}`);

  new AgentWebhookStack(stack, 'AgentWebhook', {
    receiverLambda: fn('Receiver'),
    authorizerLambda: fn('Authorizer'),
    postCommentLambda: fn('PostComment'),
    prepareGitAuthLambda: fn('PrepareGitAuth'),
    invokeClaudeLambda: fn('InvokeClaude'),
    monitorCheckLambda: fn('MonitorCheck'),
    claudeCodeRuntimeArn: '',
    harnessArn: '',
    stateMachineName: 'test-state-machine',
  });

  const template = Template.fromStack(stack);
  const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
  const [stateMachine] = Object.values(stateMachines);
  assert.ok(stateMachine, 'expected exactly one state machine in the stack');
  const definition = JSON.parse(stateMachine.Properties.DefinitionString['Fn::Join'][1].join(''));
  return definition.States;
}

test('PostMonitorStoppedComment (maxIterations expiry) re-invokes instead of ending the execution', () => {
  const states = synthStateMachine();

  const stopped = states['PostMonitorStoppedComment'];
  assert.ok(stopped, 'PostMonitorStoppedComment state should exist');
  // A terminal state either omits `Next` and sets `End: true`, or has no
  // `Next` at all. Assert it now has a `Next` pointing at the re-invoke prep.
  assert.equal(stopped.End, undefined, 'PostMonitorStoppedComment must not be a terminal state anymore (issue #425)');
  assert.equal(stopped.Next, 'PrepareMonitorExpiredReinvoke');

  const prepare = states['PrepareMonitorExpiredReinvoke'];
  assert.ok(prepare, 'PrepareMonitorExpiredReinvoke state should exist');
  assert.equal(prepare.Next, 'InvokeClaude');
  assert.match(prepare.Parameters['effectivePrompt.$'], /monitor_context/);
});

test('the monitor_expired comment payload does not carry stage: monitor_stopped', () => {
  const states = synthStateMachine();
  const stopped = states['PostMonitorStoppedComment'];
  assert.equal(stopped.Parameters.stage, 'monitor_expired');
});
