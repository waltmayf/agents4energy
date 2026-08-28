/**
 * Spike #514 experiment — criterion 5: does the real `AgentCoreApplication`
 * L3 construct (raw CDK, from web/amplify/constructs/) synth inside a Blocks
 * CDK app, alongside a `BlocksStack`? Imported by index.cdk.ts only when
 * AGENTCORE_SYNTH_EXPERIMENT=1, so it never affects the normal Blocks flow.
 *
 * Deliberately minimal: reuses the real memories/runtimes/policyEngines from
 * agentcore.config.ts, but passes harnesses: [] to skip the harness system-
 * prompt/Cognito-authorizer wiring backend.ts does — that wiring is orthogonal
 * to the thing under test (whether the construct tree cross-loads at all).
 */
import * as cdk from 'aws-cdk-lib';
import { AgentCoreApplication } from '../../../web/amplify/constructs/agentCoreApplication';
import { memories, runtimes, policyEngines } from '../../../web/amplify/agentcore/agentcore.config';

export function addAgentCoreSynthExperimentStack(app: cdk.App) {
  const stack = new cdk.Stack(app, 'blocks-poc-agentcore-experiment');
  new AgentCoreApplication(stack, 'AgentCoreApplication', {
    projectName: 'blocksSpike',
    memories,
    runtimes,
    policyEngines,
    harnesses: [],
  });
  return stack;
}
