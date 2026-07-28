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

    // Both agent branches converge on the same PostFinalComment step (they
    // produce the identical $.agentResult.Output.Message.Content shape).
    invokeHarness.next(postFinal);
    invokeClaude.next(postFinal);

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
      timeout: Duration.hours(4),
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
  }

  public get webhookUrl(): string {
    return `${this.httpApi.apiEndpoint}/webhook`;
  }
}
