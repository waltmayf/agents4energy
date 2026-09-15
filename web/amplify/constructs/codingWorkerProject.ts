import { Construct } from 'constructs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';

// Resolve this file's directory in a way that works under both the Amplify
// bundler and the ESM synth-check runner (no ambient `__dirname` — mirror the
// sibling constructs, e.g. agentCoreApplication.ts / syncCedarPolicies.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));

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
   * Build image the worker runs in. Defaults to the ClaudeCode container image
   * baked as a CDK `DockerImageAsset` (built from
   * `web/amplify/agentcore/ClaudeCode/`) and published to the CDK bootstrap
   * container-assets ECR repo — so the `claude` CLI + worker code + pinned deps
   * are already present and the buildspec runs the BAKED
   * `/app/codebuild-entrypoint.js` on a `NO_SOURCE` project (no checkout, no
   * `npm ci`). The image is `linux/arm64` (the ClaudeCode Dockerfile forces it),
   * so the construct uses `LinuxArmBuildImage.fromEcrRepository(...)`, which sets
   * the CodeBuild environment type to `ARM_CONTAINER` and auto-grants the
   * service role ECR pull on the asset repo. Override only to pin a different
   * image (must be arm64 to keep the ARM_CONTAINER environment valid).
   * @default the ClaudeCode `DockerImageAsset` image (arm64)
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
 * Slice 1 (#560) provisioned the project + role; slice 2a (#570) ported the
 * worker logic. Slice 2b (#571) BAKES that worker code into a CDK
 * `DockerImageAsset` (built from the ClaudeCode container context —
 * `web/amplify/agentcore/ClaudeCode/`, which already has the Dockerfile, the
 * `codebuild-entrypoint.js`/`worker-core.js` + sibling modules, and the pinned
 * lockfile) and uses it as the CodeBuild build image. CDK publishes the asset
 * to the bootstrap `cdk-hnb659fds-container-assets-<acct>-<region>` ECR repo;
 * `LinuxArmBuildImage.fromEcrRepository(...)` points the project at it and
 * auto-grants the service role ECR pull. Because the image has `WORKDIR /app`
 * with the `claude` CLI (global), the worker code, and its deps already baked,
 * the buildspec just runs `node /app/codebuild-entrypoint.js` on a `NO_SOURCE`
 * project — no self-checkout and no `npm ci`. It does NOT wire any trigger yet
 * (the GitHub-Actions event router / SFN monitor loop are slices #4/#5) — the
 * project is driven by `StartBuild` (from Step Functions or a GitHub Actions
 * workflow), which supplies the `A4E_*` job-payload environment variables.
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

    // Bake the worker into a CDK `DockerImageAsset` (epic #558, slice 2b/7 —
    // issue #571). The context is the ClaudeCode container build dir, which
    // already holds the Dockerfile (forces `--platform=linux/arm64`), the
    // `codebuild-entrypoint.js`/`worker-core.js` worker code + sibling `*.js`
    // modules, and the pinned `package.json`/`package-lock.json`. CDK computes
    // the asset hash from this context at synth time WITHOUT building the image
    // (Docker is only needed at `cdk deploy`/CI, not for `test:synth`), then
    // publishes it to the bootstrap `cdk-hnb659fds-container-assets-*` ECR repo.
    // Built for arm64 to match the Dockerfile's forced platform.
    const workerImage =
      props.buildImage ??
      new DockerImageAsset(this, 'WorkerImage', {
        directory: resolve(__dirname, '..', 'agentcore', 'ClaudeCode'),
        platform: Platform.LINUX_ARM64,
      });
    // When we built the asset ourselves, wrap it as an ARM ECR build image:
    // `fromEcrRepository` sets the CodeBuild environment type to ARM_CONTAINER
    // (required by the arm64 image) and auto-grants the service role ECR pull
    // (BatchCheckLayerAvailability/GetDownloadUrlForLayer/BatchGetImage on the
    // asset repo + GetAuthorizationToken on `*`), so no manual ECR grant below.
    const buildImage: codebuild.IBuildImage =
      workerImage instanceof DockerImageAsset
        ? codebuild.LinuxArmBuildImage.fromEcrRepository(
            workerImage.repository,
            workerImage.imageTag,
          )
        : workerImage;

    this.project = new codebuild.Project(this, 'Project', {
      projectName: props.projectName,
      // Real worker buildspec (epic #558, slice 2b/7 — issue #571). The project
      // is `NO_SOURCE`; `StartBuild` (from the future GitHub-Actions router /
      // SFN loop, slices #4/#5) supplies the `A4E_*` job payload (prompt, repo,
      // issue, tokens) via `--environment-variables-override` — see the
      // entrypoint's contract block. There is NO self-checkout and NO `npm ci`:
      // the baked image has `WORKDIR /app` with the `claude` CLI (global), the
      // worker code, and its pinned deps already installed, so we just run
      // `node /app/codebuild-entrypoint.js`. The absolute path lets it run from
      // any cwd; the entrypoint imports its siblings via relative paths. The
      // worker clones the TARGET repo (`A4E_REPO`) into
      // `$WORKSPACE_ROOT/<name>` (WORKSPACE_ROOT defaults to
      // `$CODEBUILD_SRC_DIR`), so it collides with nothing. Tokenless: no CDK
      // token appears in the buildspec, so this construct stays a clean sink.
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: ['node /app/codebuild-entrypoint.js'],
          },
        },
        // The entrypoint writes its structured result to $CODEBUILD_SRC_DIR/
        // a4e-result.json (path overridable via A4E_RESULT_PATH). Declared here
        // so a StartBuild `artifactsOverride` (wired by the SFN loop, #564) can
        // capture it; with the project's default NO_ARTIFACTS this block is a
        // no-op. The result is also mirrored to SSM (A4E_RESULT_SSM_PATH).
        artifacts: {
          files: ['a4e-result.json'],
          'base-directory': '$CODEBUILD_SRC_DIR',
        },
      }),
      environment: {
        buildImage,
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

    // --- ECR: no manual grant needed. The build image is the baked worker
    // `DockerImageAsset` wrapped via `LinuxArmBuildImage.fromEcrRepository(...)`,
    // and the CodeBuild L2 Project auto-grants its service role pull on that
    // asset repo (BatchCheckLayerAvailability/GetDownloadUrlForLayer/
    // BatchGetImage scoped to the repo + GetAuthorizationToken on `*`) — the
    // former hand-rolled repository-wide ECR statements were removed to avoid
    // confusion. (If a caller overrides `buildImage` with a non-asset ECR image
    // via `fromEcrRepository`, that path grants pull too.)

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
