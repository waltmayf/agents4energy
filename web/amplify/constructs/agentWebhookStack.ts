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
  /** Lambda that invokes the AgentCore runtime in sync mode. */
  invokeAgentLambda: lambda.IFunction;
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
 *            Tail link comment, mints a GitHub token if source=github
 *         2. agent-webhook-invoke-agent — sync-invokes the AgentCore runtime
 *         3. agent-webhook-post-comment (stage=final) — posts the agent's response
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
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.initialComment',
    });

    const invokeAgent = new tasks.LambdaInvoke(this, 'InvokeAgent', {
      lambdaFunction: props.invokeAgentLambda,
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
      resultPath: '$.agentResult',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(14)),
    });

    const postFinal = new tasks.LambdaInvoke(this, 'PostFinalComment', {
      lambdaFunction: props.postCommentLambda,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        source: sfn.JsonPath.stringAt('$.source'),
        stage: 'final',
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        responseText: sfn.JsonPath.stringAt('$.agentResult.response'),
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
        repo: sfn.JsonPath.stringAt('$.repo'),
        issueNumber: sfn.JsonPath.numberAt('$.issueNumber'),
        issueKey: sfn.JsonPath.stringAt('$.issueKey'),
        responseText: sfn.JsonPath.stringAt('$.error.Cause'),
      }),
      payloadResponseOnly: true,
      resultPath: sfn.JsonPath.DISCARD,
    });

    invokeAgent.addCatch(postFailureComment, { resultPath: '$.error' });

    const definition = postInitial.next(invokeAgent).next(postFinal);

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: props.stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(15),
    });

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
