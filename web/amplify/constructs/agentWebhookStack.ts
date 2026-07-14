import { Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface AgentWebhookStackProps {
  /** Lambda backing the API Gateway route — verifies signatures and starts the state machine. */
  receiverLambda: lambda.IFunction;
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
   * Harness ARN for the native `bedrockagentcore:invokeHarness` task. Passed as
   * a plain string (the state machine role is granted InvokeHarness on it below).
   * May be empty at synth on branches that don't deploy the harness — the state
   * machine still synthesizes; the invoke task fails cleanly at run time.
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
 * Runs alongside .github/workflows/agent-mention.yml rather than replacing it — see
 * the docs page for why (distinct trigger phrase avoids double-firing on GitHub).
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
        logStreamName: sfn.JsonPath.stringAt('$.initialComment.logStreamName'),
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
          HarnessArn: props.harnessArn,
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
        Retry: [
          {
            ErrorEquals: ['BedrockAgentCore.ThrottlingException'],
            IntervalSeconds: 2,
            MaxAttempts: 3,
            BackoffRate: 2.0,
          },
        ],
      },
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

    // Both the git-auth prep and the native invoke route their failures to the
    // same failure-comment state (which adds agent-error for label runs).
    prepareGitAuth.addCatch(postFailureComment, { resultPath: '$.error' });
    invokeHarness.addCatch(postFailureComment, { resultPath: '$.error' });

    const definition = postInitial
      .next(prepareGitAuth)
      .next(invokeHarness)
      .next(postFinal);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(15),
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

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      description: 'Webhook receiver for GitHub/Jira agent-mention comments',
    });

    this.httpApi.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ReceiverIntegration', props.receiverLambda),
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
