import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

export interface CodingWorkerProjectProps {
  /**
   * Physical CodeBuild project name. Should be made unique per sandbox/branch
   * by the caller (same scheme as the other physical names in backend.ts) so
   * concurrent deployments in one account don't collide.
   */
  projectName: string;

  /**
   * CodeBuild compute type. This is ALSO the ephemeral-disk knob: on-demand
   * CodeBuild sizes the build volume by compute type (SMALL ≈ 64 GB,
   * MEDIUM ≈ 128 GB, LARGE/2XLARGE larger still), and escaping the 1 GB
   * AgentCore `/mnt/workspace` wedge (#531) is the whole point of the move — so
   * the default is MEDIUM, well above the ~1 GB the runtime gave the worker.
   * Bump this to scale disk/CPU/memory for a heavier monorepo checkout.
   * @default codebuild.ComputeType.MEDIUM
   */
  computeType?: codebuild.ComputeType;

  /**
   * Build image the worker runs in. Defaults to the CodeBuild standard Linux
   * image; slice #561 may switch this to the existing ClaudeCode ECR image once
   * the worker logic is ported (the service role is already granted ECR pull).
   * @default codebuild.LinuxBuildImage.STANDARD_7_0
   */
  buildImage?: codebuild.IBuildImage;

  /**
   * Hard build timeout. CodeBuild's ceiling is 8 h — the design doc's headline
   * win over the runtime's ~3 h ceiling (#166), so default to the max.
   * @default Duration.hours(8)
   */
  timeout?: Duration;

  /**
   * Optional VPC placement. Left as an explicit, documented parameter: the
   * worker only needs a VPC if a future tool it drives must reach VPC-private
   * resources; a plain GitHub + Bedrock + AppSync worker does not. When set,
   * `subnetSelection` and `securityGroups` are forwarded to the project.
   * @default undefined — the project runs in the CodeBuild-managed network.
   */
  vpc?: ec2.IVpc;
  /** Subnet selection when `vpc` is set. @default private-with-egress subnets */
  subnetSelection?: ec2.SubnetSelection;
  /** Security groups when `vpc` is set. @default a project-managed default SG */
  securityGroups?: ec2.ISecurityGroup[];

  /**
   * SSM Parameter Store path prefix (e.g. `/agentcore/<agentStackName>`) the
   * worker reads deploy outputs from (memory id/arn, region, gateway ids, …).
   * The service role is granted `ssm:GetParameter*` under `<prefix>/*`. Passed
   * as a plain string by the caller so this construct stays a tokenless sink
   * (no cross-stack CDK token that could close a dependency cycle).
   * @default `/agentcore/*` in this account/region (all agentcore params)
   */
  agentcoreSsmPathPrefix?: string;
}

/**
 * Permanent AWS CodeBuild project + IAM service role that will host the
 * `@agentcore-claude` coding worker, replacing the `ClaudeCode` AgentCore
 * Runtime (epic #558, slice 1/7 — issue #560). See
 * docs/codebuild-worker-migration.md.
 *
 * This slice provisions ONLY the project + role. It does NOT port the worker
 * logic (slice #561) and does NOT wire any trigger (the GitHub-Actions event
 * router / SFN monitor loop are slices #4/#5) — the project starts with a
 * placeholder inline buildspec that slice #561 replaces, and is expected to be
 * driven by `StartBuild` (from Step Functions or a GitHub Actions workflow).
 *
 * Built as a raw CDK construct meant to live in its OWN `backend.createStack(...)`
 * — NOT an Amplify `defineFunction` — following SyncCedarPolicies /
 * AgentWebhookStack / S3ToolsGatewayTarget. A dedicated sink stack keeps this
 * self-contained: it depends on nothing that depends back on it, so no
 * `data -> function -> data` (or any other) CloudFormation dependency cycle can
 * form. To stay a clean sink it takes only PLAIN STRINGS for anything derived
 * from another stack (the SSM path prefix), never a cross-stack CDK token.
 */
export class CodingWorkerProject extends Construct {
  /** The CodeBuild project. */
  public readonly project: codebuild.Project;
  /** The project's IAM service role ARN (for downstream wiring). */
  public readonly serviceRoleArn: string;

  constructor(scope: Construct, id: string, props: CodingWorkerProjectProps) {
    super(scope, id);

    const { account, region } = Stack.of(this);

    const inVpc = Boolean(props.vpc);

    this.project = new codebuild.Project(this, 'Project', {
      projectName: props.projectName,
      // No source + inline buildspec: this slice creates infrastructure only.
      // The real worker entrypoint (clone repo, run `claude`, publish session
      // events, push a draft PR) is ported in slice #561; until then the
      // project is startable and self-tests its environment. Triggers are wired
      // later (slices #4/#5) via StartBuild, which supplies the source override.
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "agents4energy coding worker — placeholder buildspec (issue #560)."',
              'echo "Worker logic is ported in slice #561."',
              'df -h /',
            ],
          },
        },
      }),
      environment: {
        buildImage: props.buildImage ?? codebuild.LinuxBuildImage.STANDARD_7_0,
        // Compute type doubles as the ephemeral-disk knob (see prop doc).
        computeType: props.computeType ?? codebuild.ComputeType.MEDIUM,
        // The worker will run the `claude` CLI, which may need to run tooling
        // in Docker for some repos; privileged mode is cheap to enable now and
        // avoids a project replacement later if slice #561 needs it.
        privileged: true,
      },
      // 8 h ceiling — the design doc's key win over the runtime's ~3 h (#166).
      timeout: props.timeout ?? Duration.hours(8),
      // Optional VPC placement (see prop docs). Only forwarded when a VPC is
      // supplied so a normal deploy adds no VPC/ENI plumbing.
      ...(inVpc
        ? {
            vpc: props.vpc,
            subnetSelection: props.subnetSelection,
            securityGroups: props.securityGroups,
          }
        : {}),
    });

    this.serviceRoleArn = this.project.role!.roleArn;

    // --- Bedrock: the worker calls Claude via Bedrock (use_bedrock). Cross-
    // region inference profiles fan out to foundation models in several
    // regions, so grant InvokeModel[WithResponseStream] on BOTH the
    // inference-profile ARNs and the foundation-model ARNs (mirrors the
    // name-chat-session grant in backend.ts).
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${account}:inference-profile/*`,
      ],
    }));

    // --- AppSync (SigV4): the worker publishes session events to the data API
    // so the browser live-view (#17/#15) keeps working. It does a
    // list-then-upsert, so grant BOTH Query AND Mutation field ARNs — a
    // Mutation-only grant would silently no-op the list, and a Query-only grant
    // would silently no-op the write (the errors are swallowed). Wildcard ARNs
    // (not the data-stack API ARN token) keep this a tokenless sink, exactly
    // like the ClaudeCode runtime's own AppSync grant in backend.ts.
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['appsync:GraphQL'],
      resources: [
        'arn:aws:appsync:*:*:apis/*/types/Query/fields/*',
        'arn:aws:appsync:*:*:apis/*/types/Mutation/fields/*',
      ],
    }));

    // --- SSM: the worker reads deploy outputs (memory id/arn, region, gateway
    // ids) from `/agentcore/<stackName>/*`. Scope to the caller-supplied prefix
    // when given, else all agentcore params in this account/region.
    const ssmPrefix = props.agentcoreSsmPathPrefix ?? '/agentcore';
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${ssmPrefix}/*`],
    }));

    // --- ECR: pull the existing ClaudeCode image (built via CodeBuild → ECR by
    // @aws/agentcore-cdk). GetAuthorizationToken has no resource scope (AWS:
    // `*` only); the layer/image reads are scoped to repositories in this
    // account/region. Slice #561 can tighten to the specific repository ARN if
    // it switches `buildImage` to that image.
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    this.project.addToRolePolicy(new PolicyStatement({
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: [`arn:aws:ecr:${region}:${account}:repository/*`],
    }));

    // --- CloudWatch Logs: CodeBuild streams build logs to a `/aws/codebuild/`
    // group. The L2 Project already grants its role the logs perms for its
    // default group; this is explicit belt-and-braces per the acceptance
    // criteria and covers the named project group.
    this.project.addToRolePolicy(new PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/${props.projectName}`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/codebuild/${props.projectName}:*`,
      ],
    }));
  }
}
