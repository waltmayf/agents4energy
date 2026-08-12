import { Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface AgentWebhookStackProps {
  /** Lambda backing the API Gateway route — verifies signatures and starts the state machine. */
  receiverLambda: lambda.IFunction;
  /**
   * REQUEST authorizer Lambda in front of receiverLambda (issue #83). For
   * GitHub deliveries, rejects requests with a missing/malformed
   * `X-Hub-Signature-256` before they reach the receiver — a signature-FORMAT
   * gate only. It cannot verify the HMAC itself (authorizers never see the
   * request body), so that check stays in receiverLambda; this is defense in
   * depth, not a replacement. Jira deliveries (no such header) pass through.
   */
  authorizerLambda: lambda.IFunction;
  /** Lambda that posts the initial (Live Tail link) and final comments. */
  postCommentLambda: lambda.IFunction;
  /**
   * Lambda that seeds git/gh credentials in the harness session (via
   * InvokeAgentRuntimeCommand) and returns the annotated prompt. The harness
   * invoke itself is a native `bedrockagentcore:invokeHarness` Step Functions
   * task, not this Lambda — see the class doc and issue #56.
   */
  prepareGitAuthLambda: lambda.IFunction;
  /**
   * Lambda that kicks off the Claude Code AgentCore Runtime for `@agentcore-claude`
   * mentions (see agent-webhook-invoke-claude). Invoked via the Step Functions
   * callback pattern (issue #175): it hands the runtime a task token and returns
   * immediately, and the runtime later resumes the paused task with the
   * $.agentResult shape (same as the native invokeHarness task), so the shared
   * PostFinalComment step reads both identically.
   */
  invokeClaudeLambda: lambda.IFunction;
  /**
   * Lambda that runs a monitor spec's `checkCommand` in the ClaudeCode runtime
   * session and returns `{ conditionMet, exitCode, stdout, stderr }` (issue
   * #262). Only used by the monitor loop entered when InvokeClaude resolves with
   * `agentStatus: 'monitoring'`; harness/label runs never reach it.
   */
  monitorCheckLambda: lambda.IFunction;
  /**
   * ARN of the Claude Code AgentCore Runtime. The state machine role is granted
   * `bedrock-agentcore:InvokeAgentRuntime` on it so the InvokeClaude Lambda's
   * SigV4 call succeeds. May be empty at synth on branches that don't deploy the
   * runtime — the grant is then skipped and the claude branch fails cleanly.
   */
  claudeCodeRuntimeArn: string;
  /**
   * Harness ARN for the native `bedrockagentcore:invokeHarness` task. Passed as
   * a plain string (the state machine role is granted InvokeHarness on it below).
   * May be empty at synth on branches that don't deploy the harness — a
   * syntactically-valid placeholder ARN is then substituted into the task
   * definition (SFN validates ARN format at deploy time), and the InvokeHarness
   * IAM grant is skipped. The harness branch is never routed to while the
   * harness is absent, so the placeholder is never actually invoked.
   */
  harnessArn: string;
  /**
   * Physical name for the state machine. Required so callers can compute its
   * ARN as a plain string (region/account are always known, the name is fixed)
   * instead of reading `stateMachine.stateMachineArn` — that token is a
   * cross-stack CloudFormation reference, and granting it to receiverLambda's
   * role (which lives in the Amplify function stack) would make the function
   * stack depend on this stack while this stack already depends on the
   * function stack for postCommentLambda/invokeAgentLambda/receiverLambda's
   * ARNs — a circular nested-stack dependency CloudFormation rejects.
   */
  stateMachineName: string;
}

/**
 * Webhook → Step Function pipeline (see docs/webhook-stepfunction-integration.md):
 *   API Gateway HTTP API → agent-webhook-receiver Lambda (verify + StartExecution)
 *     → Step Function:
 *         1. agent-webhook-post-comment (stage=initial) — posts the CloudWatch Live
 *            Tail link comment, mints a GitHub token, adds agent-working (label runs)
 *         2. agent-webhook-invoke-agent (git-auth prep) — seeds git/gh credentials in
 *            the harness session via InvokeAgentRuntimeCommand, returns the prompt
 *         3. InvokeHarness — NATIVE `bedrockagentcore:invokeHarness` task; returns
 *            the decoded final assistant message ($.Output.Message.Content[0].Text)
 *         4. agent-webhook-post-comment (stage=final) — posts the agent's response,
 *            removes agent-working (label runs)
 *
 * The harness invoke is the native optimized integration (issue #56): it decodes
 * the streamed response into a Converse-shaped result, so no hand-rolled event-
 * stream decoding is needed. Git-auth stays a Lambda because InvokeAgentRuntimeCommand
 * (the exec API) has no optimized integration and its stdout/stderr must be logged
 * for debugging.
 *
 * This is now the sole GitHub/Jira mention pipeline — it superseded the
 * Actions-based .github/workflows/agent-mention.yml flow, which targeted the
 * since-retired AgUiHandler runtime (#33) and was removed (#191).
 */
export class AgentWebhookStack extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly stateMachine: sfn.StateMachine;
  // Plain-string ARN, safe to hand to callers outside this stack (e.g. the
  // receiver Lambda's STATE_MACHINE_ARN env var) without the cross-stack
  // token cycle described on stateMachineName above.
  public readonly stateMachineArn: string;

  constructor(scope: Construct, id: string, props: AgentWebhookStackProps) {
    super(scope, id);

    const stack = Stack.of(this);
    this.stateMachineArn = `arn:aws:states:${stack.region}:${stack.account}:stateMachine:${props.stateMachineName}`;

    // The native invokeHarness task's `HarnessArn` field is schema-validated for
    // ARN *format* at deploy time (SFN rejects both an empty string and a
    // malformed value with SCHEMA_VALIDATION_FAILED). On branches that don't
    // deploy the harness (props.harnessArn === '', e.g. AGENTCORE_SKIP_HARNESS=1),
    // substitute a syntactically-valid placeholder so the definition validates —
    // the harness branch is never routed to while the harness is absent, so this
    // ARN is never actually invoked.
    const harnessArnForTask =
      props.harnessArn ||
      `arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:harness/placeholder-harness-not-deployed`;

    const postInitial = new tasks.LambdaInvoke(this, 'PostInitialComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        stage: 'initial',
        trigger: sfn.JsonPath.stringAt('$.trigger'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.initialComment',
    });

    // Step 2 — git-auth prep (Lambda). Seeds git/gh credentials in the harness
    // session and returns the <github_context>/<github_access>-annotated
    // prompt as $.prepared.effectivePrompt. NOT the harness invoke — that's
    // the native task below.
    const prepareGitAuth = new tasks.LambdaInvoke(this, 'PrepareGitAuth', {
      lambdaFunction: props.prepareGitAuthLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        prompt: sfn.JsonPath.stringAt('$.prompt'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        githubToken: sfn.JsonPath.stringAt('$.initialComment.githubToken'),
        logGroupName: sfn.JsonPath.stringAt('$.initialComment.logGroupName'),
        agentsSystemPrompt: sfn.JsonPath.stringAt('$.initialComment.agentsSystemPrompt'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.prepared',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
    });

    // Step 3 — native AgentCore harness invoke (issue #56). The optimized
    // `bedrockagentcore:invokeHarness` integration decodes the streamed response
    // into a Converse-shaped result, so we read the final assistant text directly
    // from $.agentResult.Output.Message.Content[0].Text — no hand-rolled event-
    // stream decoding. Request-Response only; 15-min hard cap. Parameters are
    // PascalCase; nested path refs use the "<Key>.$" JSONPath form.
    // Docs: https://docs.aws.amazon.com/step-functions/latest/dg/connect-bedrockagentcore.html
    const invokeHarness = new sfn.CustomState(this, 'InvokeHarness', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::bedrockagentcore:invokeHarness',
        Parameters: {
          HarnessArn: harnessArnForTask,
          'RuntimeSessionId.$': '$.runId',
          Messages: [
            {
              Role: 'user',
              Content: [{ 'Text.$': '$.prepared.effectivePrompt' }],
            },
          ],
          // Bounded below the state machine's own 15-min timeout so the invoke,
          // not the whole execution, is what surfaces a timeout error to Catch.
          TimeoutSeconds: 840,
        },
        ResultPath: '$.agentResult',
        // Retry the transient, server-side classes the native invokeHarness task
        // surfaces — all observed as HTTP 424 and explicitly transient ("Try your
        // request again" / upstream read timeout), never caller errors (#123,
        // subsuming #76 InternalServerException and #86 RuntimeClientErrorException).
        // A single hiccup otherwise goes straight to the failure path and stamps
        // agent-error on the issue/PR, discarding an otherwise-correct run.
        // Attempts stay bounded (per #86, RuntimeClientErrorException can in
        // principle wrap a genuine client-side harness/tool error) so real
        // failures still surface promptly. Each retry restarts the harness with a
        // fresh turn — safe, but partial progress is not resumed.
        Retry: [
          {
            ErrorEquals: [
              'BedrockAgentCore.ThrottlingException',
              'BedrockAgentCore.InternalServerException',
              'BedrockAgentCore.RuntimeClientErrorException',
            ],
            IntervalSeconds: 2,
            MaxAttempts: 3,
            BackoffRate: 2.0,
          },
        ],
      },
    });

    // Step 3 (alternative) — Claude Code AgentCore Runtime invoke (Lambda +
    // callback token). For `@agentcore-claude` mentions the Lambda calls
    // InvokeAgentRuntime on the ClaudeCode runtime, which clones the repo and
    // runs the Claude Code CLI. A real Claude Code job routinely runs far longer
    // than the 15-min Lambda / state-machine ceiling the synchronous path was
    // capped at (often >1h), so this uses the Step Functions callback pattern
    // (`.waitForTaskToken`, issue #175): the invoke Lambda hands the runtime a
    // task token and returns immediately, and the execution PAUSES here until the
    // runtime itself calls SendTaskSuccess/SendTaskFailure with the token (up to
    // the taskTimeout below, matching AgentCore's ~hours-long session limits).
    // Unlike the harness this has no optimized SFN integration — the runtime
    // streams an HTTP body, not a Converse-shaped result — so it stays a Lambda.
    const invokeClaude = new tasks.LambdaInvoke(this, 'InvokeClaude', {
      lambdaFunction: props.invokeClaudeLambda,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        // The callback token the runtime uses to resume this paused state. Passed
        // through the invoke Lambda into the runtime payload; the runtime returns
        // the final result via SendTaskSuccess (not the Lambda's return value,
        // which the token pattern ignores).
        taskToken: sfn.JsonPath.taskToken,
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        prompt: sfn.JsonPath.stringAt('$.prepared.effectivePrompt'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        githubToken: sfn.JsonPath.stringAt('$.initialComment.githubToken'),
        agentsSystemPrompt: sfn.JsonPath.stringAt('$.initialComment.agentsSystemPrompt'),
        logGroupName: sfn.JsonPath.stringAt('$.initialComment.logGroupName'),
        logStreamName: sfn.JsonPath.stringAt('$.initialComment.logStreamName'),
      }),
      // NOT payloadResponseOnly: with WAIT_FOR_TASK_TOKEN the task result comes
      // from the SendTaskSuccess `output`, not the Lambda's synchronous return.
      // The runtime sends `{ Output: { Message: { Role, Content: [{ Text }] } } }`
      // (the same shape the native invokeHarness task produces), landing at
      // $.agentResult so the shared PostFinalComment step reads both identically.
      resultPath: '$.agentResult',
      // Cap the paused wait at ~3h to match AgentCore's session limits — a job
      // that hasn't reported back by then is treated as timed out and routed to
      // the failure path. The state machine `timeout` below is set comfortably
      // higher so this task-level timeout, not the execution timeout, is what
      // surfaces to Catch.
      taskTimeout: sfn.Timeout.duration(Duration.hours(3)),
    });

    const postFinal = new tasks.LambdaInvoke(this, 'PostFinalComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        stage: 'final',
        trigger: sfn.JsonPath.stringAt('$.trigger'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        // Total run duration (issue #321): the execution's ISO-8601 start time
        // from the Step Functions context object. The Lambda diffs it against
        // `now` to prepend an "Agent finished after N" line to the final comment.
        // Free from the context object — no extra state or bookkeeping needed.
        executionStartTime: sfn.JsonPath.stringAt('$$.Execution.StartTime'),
        // Pass the whole content-block array (always present, even when empty)
        // and let the Lambda join the text blocks with a fallback. A direct
        // `Content[0].Text` JSONPath crashes the state when the agent's final
        // turn has no text block — the native integration omits tool-use /
        // reasoning blocks, so Content can legitimately be [] (observed on a
        // web-browsing run: StopReason=end_turn, Content=[]).
        responseContent: sfn.JsonPath.listAt('$.agentResult.Output.Message.Content'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.finalComment',
    });

    // Reached only via the RouteAwaitingInput Choice below, when the Claude Code
    // runtime resumed the paused task with `agentStatus: 'awaiting_input'`
    // (issue #185, increment 3) — the run ended asking the user a question
    // rather than finishing the work. Posts a distinct "paused" comment instead
    // of treating it as a normal completion; does NOT add agent-error.
    const postAwaitingInputComment = new tasks.LambdaInvoke(this, 'PostAwaitingInputComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        stage: 'awaiting_input',
        trigger: sfn.JsonPath.stringAt('$.trigger'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        awaitingQuestion: sfn.JsonPath.stringAt('$.agentResult.awaitingQuestion'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.finalComment',
    });

    const postFailureComment = new tasks.LambdaInvoke(this, 'PostFailureComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        stage: 'final',
        trigger: sfn.JsonPath.stringAt('$.trigger'),
        // Reached via invokeAgent's Catch — flag the issue/PR with agent-error
        // (in addition to removing agent-working) for label-triggered runs.
        isError: true,
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        // Total run duration (issue #321) — a failed run is still a finished run.
        executionStartTime: sfn.JsonPath.stringAt('$$.Execution.StartTime'),
        responseText: sfn.JsonPath.stringAt('$.error.Cause'),
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Git-auth prep and BOTH agent branches route their failures to the same
    // failure-comment state (which adds agent-error for label runs).
    prepareGitAuth.addCatch(postFailureComment, { resultPath: '$.error' });
    invokeHarness.addCatch(postFailureComment, { resultPath: '$.error' });
    invokeClaude.addCatch(postFailureComment, { resultPath: '$.error' });

    // The native harness has no way to end a turn "awaiting input" (issue #185
    // is Claude-Code-only), so it always converges on PostFinalComment.
    invokeHarness.next(postFinal);

    // ------------------------------------------------------------------
    // Monitor loop (issue #262, extended by #377). When a Claude Code run
    // ends in `agentStatus: 'monitoring'` (sub-issue 1, #261) it carries a
    // `monitorSpec` tagged with `kind`:
    //   - 'condition': { intervalSeconds, maxIterations, checkCommand,
    //     followUpPrompt }. Wait (no runtime compute held — the microVM is
    //     reclaimed on idle /ping) → RunMonitorCheck (runs checkCommand in the
    //     SAME runtime session) → RouteCheck. A passing check re-invokes
    //     Claude with the follow-up prompt; a failing check waits and
    //     re-checks; hitting maxIterations posts a final "monitor stopped"
    //     comment.
    //   - 'timed' (#377): { waitSeconds, followUpPrompt }. No condition to
    //     poll — a single Wait(waitSeconds) followed directly by a re-invoke,
    //     skipping RunMonitorCheck/RouteCheck entirely. This is the direct
    //     "pause for N seconds, then continue" shape for an orchestrator that
    //     wants to hold no runtime compute for a self-specified duration
    //     (e.g. "give workers ~3h to deliver") without needing a check
    //     command at all.
    // Both branches reuse the same runId/session so /mnt/workspace + memory
    // continuity hold across re-invokes. The condition loop is additionally
    // bounded by maxIterations; both are bounded by the state machine's
    // execution timeout (see the `timeout:` prop on the StateMachine below).
    // ------------------------------------------------------------------

    // Seed $.monitor = { iteration: 0, spec: <the emitted monitorSpec> }.
    const initMonitor = new sfn.Pass(this, 'InitMonitor', {
      parameters: {
        iteration: 0,
        'spec.$': '$.agentResult.monitorSpec',
      },
      resultPath: '$.monitor',
    });

    // Hold with NO runtime compute for the spec's interval. SecondsPath reads
    // the clamped intervalSeconds the runtime already validated (detect-monitor).
    const monitorWait = new sfn.Wait(this, 'MonitorWait', {
      time: sfn.WaitTime.secondsPath('$.monitor.spec.intervalSeconds'),
    });

    const runMonitorCheck = new tasks.LambdaInvoke(this, 'RunMonitorCheck', {
      lambdaFunction: props.monitorCheckLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        spec: sfn.JsonPath.objectAt('$.monitor.spec'),
        iteration: sfn.JsonPath.numberAt('$.monitor.iteration'),
        logGroupName: sfn.JsonPath.stringAt('$.initialComment.logGroupName'),
        logStreamName: sfn.JsonPath.stringAt('$.initialComment.logStreamName'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.monitorCheck',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
    });

    // A check failure (exec error, not a non-zero exit) shouldn't stamp
    // agent-error and discard the run — treat it like a not-yet-met condition
    // and keep looping until maxIterations. Route the Catch back to the
    // iteration bump so a transient exec hiccup just costs one interval.
    // (conditionMet defaults to false because $.monitorCheck is absent on Catch,
    // so RouteCheck's isPresent guard short-circuits to the not-met branch.)

    // On a passing check, swap the effective prompt for the monitor's follow-up
    // (plus a short context note) and re-invoke Claude in the same session.
    const prepareReinvoke = new sfn.Pass(this, 'PrepareMonitorReinvoke', {
      parameters: {
        // NOTE: inside an ASL intrinsic (States.Format) string literal the only
        // valid backslash escapes are \\ \' \{ \} — a `\n` is rejected as an
        // invalid escape and SFN fails the whole state machine at deploy with
        // SCHEMA_VALIDATION_FAILED (the synth gate can't catch this; it's SFN's
        // own service-side parse). Keep the template newline-free — the
        // <monitor_context> tags carry the semantics; newline formatting is
        // cosmetic and the agent reads the wrapped prompt fine on one line.
        'effectivePrompt.$':
          "States.Format('<monitor_context>Your monitor condition was met (the check command exited 0). Continue with the follow-up task in the same workspace/session.</monitor_context> {}', $.monitor.spec.followUpPrompt)",
      },
      resultPath: '$.prepared',
    });
    prepareReinvoke.next(invokeClaude);

    // Timed-wait branch (#377): no checkCommand, so no RunMonitorCheck/
    // RouteCheck — a single Wait(waitSeconds) then straight to a re-invoke.
    const timedMonitorWait = new sfn.Wait(this, 'TimedMonitorWait', {
      time: sfn.WaitTime.secondsPath('$.monitor.spec.waitSeconds'),
    });

    const prepareTimedReinvoke = new sfn.Pass(this, 'PrepareTimedMonitorReinvoke', {
      parameters: {
        // Same newline-free-template caveat as PrepareMonitorReinvoke above —
        // States.Format only accepts \\ \' \{ \} escapes.
        'effectivePrompt.$':
          "States.Format('<monitor_context>Your requested wait has elapsed. Continue with the follow-up task in the same workspace/session.</monitor_context> {}', $.monitor.spec.followUpPrompt)",
      },
      resultPath: '$.prepared',
    });
    prepareTimedReinvoke.next(invokeClaude);
    timedMonitorWait.next(prepareTimedReinvoke);

    // Bump the iteration counter, then loop back to Wait.
    const incrementIteration = new sfn.Pass(this, 'IncrementIteration', {
      parameters: {
        'iteration.$': 'States.MathAdd($.monitor.iteration, 1)',
        'spec.$': '$.monitor.spec',
      },
      resultPath: '$.monitor',
    });
    incrementIteration.next(monitorWait);

    // maxIterations reached without the condition being met — stop looping and
    // post a normal (non-error) final comment explaining why.
    const postMonitorStopped = new tasks.LambdaInvoke(this, 'PostMonitorStoppedComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        // A dedicated stage (not 'final'): the plain 'final' success path runs
        // a "did this GitHub run open a PR?" heuristic that overwrites
        // responseText with an unrelated "ran out of turn" message whenever no
        // PR exists — which is always, for a monitor run — silently discarding
        // this explanatory text (confirmed end-to-end, issue #263).
        stage: 'monitor_stopped',
        trigger: sfn.JsonPath.stringAt('$.trigger'),
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        responseText: sfn.JsonPath.format(
          'Monitoring stopped after {} check(s) without the condition being met.',
          sfn.JsonPath.stringAt('$.monitor.spec.maxIterations'),
        ),
      }),
      payloadResponseOnly: true,
      resultPath: '$.finalComment',
    });

    // RouteCheck: passing → re-invoke; else if next iteration would reach
    // maxIterations → stop; else → bump + loop. Guard the conditionMet read with
    // isPresent (a Catch back-route leaves $.monitorCheck absent, and a
    // booleanEquals against a missing path THROWS — same gotcha as
    // RouteAgentResult below).
    const routeCheck = new sfn.Choice(this, 'RouteCheck')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.monitorCheck.conditionMet'),
          sfn.Condition.booleanEquals('$.monitorCheck.conditionMet', true),
        ),
        prepareReinvoke,
      )
      .when(
        // iteration is 0-based; the check just completed for `iteration`, so the
        // next attempt is iteration+1. Stop once that would reach maxIterations.
        sfn.Condition.numberGreaterThanEqualsJsonPath('$.monitor.iteration', '$.monitor.spec.maxIterations'),
        postMonitorStopped,
      )
      .otherwise(incrementIteration);

    runMonitorCheck.addCatch(incrementIteration, { resultPath: '$.monitorCheckError' });

    // RouteMonitorKind (#377): a 'timed' spec skips straight to its own
    // Wait/re-invoke chain; anything else (the pre-#377 shape omitted `kind`
    // entirely, so isPresent guards it the same way RouteAgentResult below
    // guards `agentStatus`) falls through to the existing condition-poll loop.
    const routeMonitorKind = new sfn.Choice(this, 'RouteMonitorKind')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.monitor.spec.kind'),
          sfn.Condition.stringEquals('$.monitor.spec.kind', 'timed'),
        ),
        timedMonitorWait,
      )
      .otherwise(monitorWait);

    initMonitor.next(routeMonitorKind);
    monitorWait.next(runMonitorCheck);
    runMonitorCheck.next(routeCheck);

    // The Claude Code branch can resume the paused task three ways (issues #185
    // increment 3, and #262): a normal completion (no agentStatus field, routed
    // to the same PostFinalComment as the harness branch); a run that ended
    // asking the user a question (`agentStatus: 'awaiting_input'`, routed to the
    // dedicated PostAwaitingInputComment); or a run that handed off a monitoring
    // spec (`agentStatus: 'monitoring'`, routed into the Wait→check→re-invoke
    // loop above). Guard each with isPresent: a normal completion omits
    // `agentStatus` entirely, and Choice evaluation THROWS on a stringEquals
    // against a missing path rather than treating it as false — so the
    // `isPresent` conjunct must come first to short-circuit before the
    // comparison is attempted.
    const routeAgentResult = new sfn.Choice(this, 'RouteAgentResult')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.agentResult.agentStatus'),
          sfn.Condition.stringEquals('$.agentResult.agentStatus', 'awaiting_input'),
        ),
        postAwaitingInputComment,
      )
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.agentResult.agentStatus'),
          sfn.Condition.stringEquals('$.agentResult.agentStatus', 'monitoring'),
        ),
        initMonitor,
      )
      .otherwise(postFinal);
    invokeClaude.next(routeAgentResult);

    // After git-auth prep, branch on $.agent (set by agent-webhook-receiver from
    // the mention: 'claude' for @agentcore-claude, else 'harness'). Default to the
    // harness so label/Jira triggers (which never set 'claude') keep working.
    const routeAgent = new sfn.Choice(this, 'RouteAgent')
      .when(sfn.Condition.stringEquals('$.agent', 'claude'), invokeClaude)
      .otherwise(invokeHarness);

    const definition = postInitial
      .next(prepareGitAuth)
      .next(routeAgent);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      // Raised well above the old 15-min cap to accommodate the @agentcore-claude
      // callback branch (issue #175), whose InvokeClaude task can stay paused on
      // its task token for up to ~3h. Set above that task's 3h taskTimeout so the
      // task-level timeout is what surfaces to Catch, not the execution timeout.
      // The native harness branch still self-bounds at 840s via its TimeoutSeconds.
      //
      // The monitor loop (#377) can now request a single Wait/interval of up
      // to 99,999,999s (~3.17 years, the SFN Wait state's own max) — but a
      // Standard Workflow execution hard-fails at 1 year regardless (AWS
      // quota, not adjustable: https://docs.aws.amazon.com/step-functions/latest/dg/limits-overview.html#service-limits-state-machine-executions).
      // Set the execution timeout to 364 days — just under that hard ceiling,
      // leaving a day of headroom for the other steps (PostInitialComment,
      // PrepareGitAuth, etc.) around the Wait — so a legitimately long
      // monitor wait is bounded by AWS's own limit, not by an artificially
      // low value here. The `Wait` state itself holds no runtime compute
      // while paused, so this only bounds calendar time, not cost.
      timeout: Duration.days(364),
    });

    // The native invokeHarness task calls the harness with the state machine's
    // OWN role (not a Lambda role), so grant it here. InvokeHarness checks both
    // IAM actions per the SFN integration docs. Skipped when harnessArn is empty
    // (branch deploys without the harness) — the task then fails cleanly at run
    // time rather than granting `*`.
    if (props.harnessArn) {
      this.stateMachine.addToRolePolicy(new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeHarness', 'bedrock-agentcore:InvokeAgentRuntime'],
        resources: [props.harnessArn],
      }));
    }

    // The InvokeClaude branch runs as a Lambda (invokeClaudeLambda), granted
    // InvokeAgentRuntime on its OWN execution role in backend.ts — the state
    // machine only invokes the Lambda, not the runtime directly, so no runtime
    // grant is needed on the state machine role. With the callback pattern
    // (#175) the ClaudeCode RUNTIME resumes this task via SendTaskSuccess/
    // SendTaskFailure; those calls are authorized by the RUNTIME's execution
    // role (granted states:SendTask* on this.stateMachineArn in backend.ts), not
    // the state machine role, so nothing extra is added to the state machine role
    // here. The claudeCodeRuntimeArn prop is kept for symmetry/documentation and
    // future native-integration use.
    void props.claudeCodeRuntimeArn;

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'Webhook receiver for GitHub/Jira agent-mention comments',
    });

    // REQUEST authorizer (issue #83): flips the route from AuthorizationType
    // NONE to CUSTOM. Caching disabled (resultsCacheTtl=0) — every webhook
    // delivery has a unique signature, so caching an allow/deny would be
    // incorrect. Simple response format (isAuthorized boolean), matching what
    // agentWebhookAuthorizer's handler returns.
    //
    // identitySource intentionally does NOT name X-Hub-Signature-256: per the
    // HTTP API Lambda-authorizer docs, if an identity source names a header,
    // API Gateway rejects any request missing that header with a blanket 401
    // *without ever invoking the Lambda*. This route also serves Jira
    // deliveries, which never send that header — naming it here would 401
    // every Jira webhook before the authorizer Lambda got a chance to allow
    // it. $context.routeKey is always present, so every request reaches the
    // Lambda, which does the GitHub-vs-Jira branching itself.
    const authorizer = new HttpLambdaAuthorizer('WebhookAuthorizer', props.authorizerLambda, {
      authorizerName: 'webhook-signature-format',
      identitySource: ['$context.routeKey'],
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: Duration.seconds(0),
    });

    this.httpApi.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ReceiverIntegration', props.receiverLambda),
      authorizer,
    });

    props.receiverLambda.addToRolePolicy(new PolicyStatement({
      actions: ['states:StartExecution'],
      resources: [this.stateMachineArn],
    }));

    // Control plane of last-write-wins cancellation (issue #182): before
    // starting a new run, the receiver lists RUNNING executions for this state
    // machine (client-side filtered by name prefix — ListExecutions has no
    // server-side name filter) and stops/cancels every prior one for the same
    // target. ListExecutions is scoped to the state machine ARN;
    // DescribeExecution/StopExecution act on individual executions, whose ARN
    // is `<stateMachineArn with "stateMachine:" swapped for "execution:">:<name>`
    // — grant the wildcard so any execution name under this state machine works.
    const executionArnPrefix = this.stateMachineArn.replace(':stateMachine:', ':execution:');
    props.receiverLambda.addToRolePolicy(new PolicyStatement({
      actions: ['states:ListExecutions'],
      resources: [this.stateMachineArn],
    }));
    props.receiverLambda.addToRolePolicy(new PolicyStatement({
      actions: ['states:DescribeExecution', 'states:StopExecution'],
      resources: [`${executionArnPrefix}:*`],
    }));
  }

  public get webhookUrl(): string {
    return `${this.httpApi.apiEndpoint}/webhook`;
  }
}
