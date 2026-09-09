import { SFNClient, ListExecutionsCommand } from '@aws-sdk/client-sfn';

// Self-supersession guard (issue #494): a plain existence check — no
// cancellation — for whether a RUNNING execution already matches this exact
// name prefix. Used only by handler.ts's comment-mention branch, to stop an
// own-App @agentcore-claude mention from cancelling a run that is (for an
// own-App sender) necessarily itself — see that file for the full guard.
// `cancelPriorRuns` there runs its own separate ListExecutions pass because
// it also needs each match's executionArn to cancel it; this one doesn't.
//
// Takes the SFN client and state machine ARN as parameters (rather than
// reading module-scope config) so it's directly unit-testable with a stub
// client — see hasRunningExecution.test.ts.
export async function hasRunningExecution(
  sfn: Pick<SFNClient, 'send'>,
  stateMachineArn: string,
  namePrefix: string,
): Promise<boolean> {
  if (!stateMachineArn) return false;
  let nextToken: string | undefined;
  try {
    do {
      const resp = await sfn.send(new ListExecutionsCommand({
        stateMachineArn,
        statusFilter: 'RUNNING',
        nextToken,
      }));
      if ((resp.executions ?? []).some((exec) => exec.name?.startsWith(namePrefix))) return true;
      nextToken = resp.nextToken;
    } while (nextToken);
  } catch {
    return false;
  }
  return false;
}
