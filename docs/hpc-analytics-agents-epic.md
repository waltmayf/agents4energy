# Epic design: HPC Operations + Analytics use-case-pack agents

This is the durable design/re-hydration reference for the epic that adds two new
use-case-pack agents to agents4energy, porting real implementations from the
sibling `genai-demos` repo (vendored read-only under
[`reference/genai-demos/`](../reference/genai-demos/)).

Each child issue links back to its slice section here. A cold agent picking up a
slice should read (1) this doc, (2) the vendored reference files its slice maps
to, and (3) the agents4energy pattern files named below — that's everything the
slice needs; nothing depends on chat history.

## Goal

1. **HPC operations agent** — submits HPC fracing-optimization jobs in real time
   (AWS PCS + Slurm + FSx-Lustre + OpenFOAM), returning screen-out risk /
   proppant-placement metrics with tiered recommendations + financial justification.
2. **Analytics agent** — Amazon Athena-for-Spark (PySpark) querying/analyzing a
   data lake, saving plots/data artifacts to the shared file server.

## Why this shape (composability — the driving requirement)

MCP tools are **not** directly composable at the protocol level: an AgentCore
Gateway target Lambda cannot invoke another MCP tool (no in-process MCP client;
cross-tool routing would need the gateway/JWT round-trip). Cross-tool
orchestration is otherwise the model's job — which would make the analytics
agent burn a tool call to save every artifact.

The requirement is that the Athena PySpark tool **reuse the file-upload
capability internally**, with no extra agent tool call. The mechanism is a
**shared code library** both tools import — not an MCP-to-MCP call — plus
in-session auto-upload.

The "file server" is the `agentWorkspace` S3 bucket
([`web/amplify/storage/resource.ts`](../web/amplify/storage/resource.ts)), a
single `files/` root prefix, with path resolution + `../`-traversal guard in
[`web/lib/s3-fs-path.ts`](../web/lib/s3-fs-path.ts). Signed-in users and the S3
filesystem MCP tools share that prefix.

### The shared primitive: `web/lib/s3-fs-upload.ts` (new)

Sibling of `s3-fs-path.ts` / `s3-fs-diff.ts`, imported by **both** the s3-tools
handler and the PySpark tool handler. Exports:
- `ARTIFACTS_SUBPREFIX = 'artifacts'`
- `resolveArtifactsPrefix(subdir)` → `files/artifacts/<sanitized>/` — the single
  source of truth for where artifacts land (built on `s3-fs-path.ts`'s
  normalization + traversal guard).
- `uploadObjectBytes(...)` → `PutObject` (content-type sniffed; port the map in
  `reference/genai-demos/cdk/lib/tools/python/sessionSetup.py`).
- `copyObjectWithinFs(...)` → `CopyObject` — the server-side "upload from an
  existing `files/` key" primitive (a Lambda has no local disk the agent can
  see, so `UploadFile`'s "source path" = an existing key under `files/`).

### Two execution contexts for PySpark auto-upload (read carefully)

- **Context A — tool Lambda (TypeScript, in AWS Lambda).** The `athena-pyspark`
  handler orchestrates Athena and **builds the injected Python** (`sessionSetup +
  preExecution + <user code> + postExecution` via a ported `loadScript.ts`). It
  uses `s3-fs-upload.ts` only to **compute** the artifacts prefix and template it
  into the Python as `{{ARTIFACTS_S3_PREFIX}}` (replacing genai-demos'
  `{{CHAT_SESSION_PREFIX}}`). The Lambda does **not** upload plots — they don't
  exist on the Lambda.
- **Context B — injected Spark-session Python (on the Athena Spark worker).** The
  user's PySpark code writes to the worker's CWD (`plots/`, `data/`);
  `postExecution.py`'s `upload_working_directory()` boto3-uploads that CWD to the
  templated prefix **automatically at end-of-run** → the agent never spends a
  tool call.

So TS decides *where*, Python executes the *write*, both land under the same
`files/` tree, and `ListFiles`/`ReadFile`/`UploadFile` + the browser see them.

**IAM trap:** the boto3 upload runs under the **Athena Spark execution role**,
not the Lambda role — that role needs `s3:PutObject` on `files/artifacts/*`.

**Artifact path convention:** `files/artifacts/<subdir>/plots/...`, where
`<subdir>` is a tool arg (also the Athena session `[ChatSessionID:<subdir>]`
reuse tag). Agent references `/artifacts/<subdir>/...`; the frontend rewrites →
`/file?s3Key=files/artifacts/<subdir>/...` (no session id needed).

## The agents4energy gateway-target tool pattern (every tool slice follows this)

Reference implementation to copy: the **graph-traverse trio** + the block at
[`web/amplify/backend.ts:913-999`](../web/amplify/backend.ts). Each new
Lambda-backed gateway tool = four pieces:

1. **Tool Lambda** — a raw `NodejsFunction` in its own `backend.createStack(...)`
   sink stack (NOT `defineFunction`; these need custom IAM for Athena/Glue/PCS/
   SSM/S3 and must consume data-stack tokens without a CFN cycle — see the
   `graph-traverse` / `S3ToolsGatewayTarget` precedent and the synth-gate note in
   `AGENTS.md`). The handler reads the tool name from
   `context.clientContext.custom.bedrockAgentCoreToolName` (form
   `"<targetName>___<ToolName>"`), dispatches on it, and **returns `{error: msg}`
   rather than throwing**.
2. **`*GatewayTarget` construct** — copy
   [`web/amplify/constructs/graphTraverseGatewayTarget/`](../web/amplify/constructs/graphTraverseGatewayTarget/).
   Only `toolDefinitions()` (the MCP schema) and the class name change. Keep
   verbatim: `credentialProviderConfigurations=[{GATEWAY_IAM_ROLE}]`,
   `bundling.nodeModules:['@aws-sdk/client-bedrock-agentcore-control']`, and the
   IAM split (`ListGatewayTargets` on `'*'`; other target actions +
   `SynchronizeGatewayTargets` on `gatewayArn`).
3. **`*McpServerSeed` construct** — copy
   [`web/amplify/constructs/graphTraverseMcpServerSeed/`](../web/amplify/constructs/graphTraverseMcpServerSeed/).
   Idempotent SigV4 AppSync writes of `Agent` + `McpServer(serverType:'agentcore',
   url=gatewayEndpoint, gatewayTargetId)` + `AgentMcpServer` join; no-op on Delete.
4. **IAM in `backend.ts`** — resource-based
   `lambda.addPermission('AllowGatewayInvoke', principal
   bedrock-agentcore.amazonaws.com, sourceArn=AGENTCORE_GATEWAY_ARN)` **and** an
   identity-based standalone `Policy` in the sink stack granting
   `lambda:InvokeFunction` on the tool Lambda to
   `agentCoreApp.gatewayRole(gatewayName)`. **Both** required or
   `CreateGatewayTarget` 400s. Whole block gated on `if (AGENTCORE_GATEWAY_ID)`.

**Long-running tools:** existing tool Lambdas use 30-60s timeouts; Athena Spark
and Slurm jobs run minutes. Re-shape each into a **submit → poll → results**
trio of stateless tools (matching `cfdSimulationTools.ts`'s 15s poll). Never
block a single Lambda for the whole job.

## Slices

Every slice: work on a feature branch, `npx tsc --noEmit`, and for any
`web/amplify/` change `cd web && pnpm test:synth` (credential-free synth gate —
catches CFN cross-stack cycles), then push a **draft** PR early with a
`Closes #<issue>` line. Exclude `reference/` from build/lint/typecheck if it interferes.

### Slice 1 — Shared upload lib + `UploadFile` tool  *(no deps)*
- **New:** `web/lib/s3-fs-upload.ts` (+ `web/lib/s3-fs-upload.test.ts`).
- **Modify:** `web/amplify/functions/s3-tools/handler.ts` (add `UploadFile` case
  using the shared primitive); `web/amplify/constructs/s3ToolsGatewayTarget/handler.ts`
  (add `UploadFile` to `toolDefinitions()`); confirm IAM at `backend.ts:806-818`
  (CopyObject needs read+put — both already granted; verify + note in PR).
- **`UploadFile` args:** `destPath` (under `files/`) + one of `sourcePath`
  (existing `files/` key → `copyObjectWithinFs`) or `content` (inline text/base64
  → `uploadObjectBytes`).
- **AC:** deployed agent uploads a `content` payload and copies a `sourcePath`;
  `ListFiles`/`ReadFile` show them under `files/`; `../` rejected as `{error}`.
  `tsc` + `pnpm test:synth` green.

### Slice 2 — Athena PySpark workgroup + Spark execution role + data-lake seed  *(no deps)*
- **New:** `web/amplify/constructs/athenaPySparkWorkgroup/resource.ts`
  (`athena.CfnWorkGroup`, `engineVersion.selectedEngineVersion='PySpark engine
  version 3'`, `resultConfiguration.outputLocation=s3://<agentWorkspace>/athena-results/`,
  a Spark execution role with S3+Glue+Athena+CloudWatch **and `s3:PutObject` on
  `files/artifacts/*`**); `web/amplify/constructs/dataLakeSeed/{resource.ts,handler.ts}`
  (custom resource: create a Glue database + upload a couple sample CSV/Parquet
  tables — SigV4/S3 pattern like `s3ToolsMcpServerSeed`).
- **Modify:** `backend.ts` — instantiate in `backend.createStack('athena-pyspark')`;
  publish `ATHENA_PYSPARK_WORKGROUP_NAME` / `STORAGE_BUCKET_NAME` (SSM param, cycle-free).
- **Ports from:** `reference/genai-demos/cdk/lib/agentcore-stack.ts` (~L420-442).
- **AC:** synth green; after deploy `aws athena get-work-group` shows PySpark v3 +
  results location; Glue DB + seed tables exist.

### Slice 3 — PySpark submit/poll/results tool + auto-upload  *(deps: Slice 1, Slice 2)*
- **New:** `web/amplify/functions/athena-pyspark/{handler.ts, loadScript.ts,
  python/{sessionSetup,preExecution,postExecution}.py}`;
  `web/amplify/constructs/athenaPySparkGatewayTarget/`; `.../athenaPySparkMcpServerSeed/`.
- **Tools:** `SubmitPySpark` (ensure session IDLE via bounded wait, start calc →
  `{sessionId, calculationId}`), `GetPySparkStatus` (`GetCalculationExecution`
  state/progress/DPU), `GetPySparkResults` (fetch StdOut/StdErr/Result +
  `ListFiles` under `resolveArtifactsPrefix(subdir)`). Session-id → explicit
  `subdir` arg (not a process global). **Strip** all lineage/OpenLineage code.
  Change `{{CHAT_SESSION_PREFIX}}` → `{{ARTIFACTS_S3_PREFIX}}` in the Python.
- **Modify:** `backend.ts` — graph-traverse-style block; IAM
  `athena:StartSession/StartCalculationExecution/GetCalculationExecution/GetSession*/ListSessions`,
  `iam:PassRole` (Spark role), S3, Glue; both invoke grants; target + seed.
- **Ports from:** `reference/genai-demos/cdk/lib/tools/athenaPySparkTool.ts`,
  `.../tools/python/*`, `.../tools/toolUtils.ts`.
- **AC:** deployed agent runs a PySpark job writing a plot; `GetPySparkResults`
  lists it under `files/artifacts/<subdir>/plots/` **and** the S3 object exists
  (proves the Spark role's `PutObject`, not the Lambda's).

### Slice 4 — Frontend `/file` route + `/artifacts` iframe rewrite  *(parallel; dep Slice 3 for real content)*
- **New:** `web/app/(with-auth)/file/page.tsx` (`getUrl` presigned; inline render
  image/html/markdown/pdf; scope keys to `files/`); `web/lib/artifacts-preprocessing.ts`
  (`/artifacts/<rel>` → `/file?s3Key=files/artifacts/<rel>`).
- **Modify:** assistant-message render path
  (`web/components/ai-elements/message.tsx` and/or
  `web/app/(with-auth)/chat/tool-widgets/sandboxed-html.tsx`) to run the rewrite;
  reuse the existing sandboxed-iframe policy.
- **Ports from:** `reference/genai-demos/src/lib/htmlPreprocessing.ts` (~L479-488),
  `reference/genai-demos/src/app/file/page.tsx`.
- **AC:** an assistant message with `<iframe src="/artifacts/<subdir>/plots/foo.png">`
  renders the presigned image via `/file`; `cd web && pnpm lint` + a Playwright smoke pass.

### Slice 5 — PCS/Slurm/FSx cluster construct  *(no deps; costly — opt-in gated)*
- **New:** `web/amplify/constructs/realTimeParallelCluster/resource.ts` — port
  `parallelClusterRealTime.ts`: `pcs.CfnCluster` (Slurm 25.05 scale-to-zero +
  `slurmRest STANDARD`), login + `hpc7g.4xlarge` compute node groups,
  `fsx.CfnFileSystem` LUSTRE with S3 import/export to `s3://<bucket>/cfd-simulations`
  (`autoImportPolicy NEW_CHANGED`) mounted `/fsx`, optional OpenFOAM AMI. Expose
  `clusterId`, login-node tag, FSx DNS.
- **Modify:** `backend.ts` — `backend.createStack('hpc-cluster')` **behind a CDK
  context flag** so this expensive stack is opt-in; publish clusterId / head-node
  tag / prefix to SSM.
- **Ports from:** `reference/genai-demos/amplify/custom/parallelClusterRealTime.ts`,
  `reference/genai-demos/cdk/lib/hpc-stack.ts`.
- **AC:** synth green; when the flag is on, deploy → cluster `ACTIVE`, FSx mounts `/fsx`.

### Slice 6 — CFD submit/poll/results tools  *(deps: Slice 1, Slice 5)*
- **New:** `web/amplify/functions/cfd-tools/handler.ts` (port
  `cfd-simulation-manager/{submitCfdSimulation,getCfdJobStatus,getCfdResults}.ts`
  into 3 tool cases: validate plan; inline Slurm/OpenFOAM script gen — steady
  `simpleFoam` / transient `pimpleFoam` from `stages[]`; EC2 tag login-node
  lookup; SSM `sbatch`; parse `Submitted batch job N`; `squeue` status; results
  FSx→S3 at `cfd-simulations/<jobid>/results/`; synthetic fallback if OpenFOAM
  absent); `.../cfdToolsGatewayTarget/`, `.../cfdToolsMcpServerSeed/`.
- **Treatment-plan input schema:** injectionRate / proppantConcentration /
  fluidViscosity / treatingPressure / `stages[]` (pad/slurry/flush) — from
  `cfdSimulationTools.ts` + `cfd.schema.ts`.
- **Modify:** `backend.ts` — sink stack + IAM (`pcs:GetCluster`,
  `ec2:DescribeInstances`, `ssm:SendCommand`/`GetCommandInvocation`,
  `secretsmanager:GetSecretValue`, S3 `cfd-simulations/*`+`files/artifacts/*`);
  both invoke grants; target + seed; gated on `AGENTCORE_GATEWAY_ID` + the HPC flag.
- **Ports from:** `reference/genai-demos/cdk/lib/tools/cfdSimulationTools.ts`,
  `.../amplify/functions/cfd-simulation-manager/*`, `.../schemas/cfd.schema.ts`,
  `.../amplify/functions/slurm-job-submitter/*` (optional generic Slurm-REST path).
- **AC:** with cluster up, `SubmitCfdSimulation` returns a Slurm job id;
  `GetCfdJobStatus` → COMPLETED; `GetCfdResults` returns metrics; results in S3.

### Slice 7 — Continuous-optimization real-time loop  *(deps: Slice 6; advanced)*
- **New:** `web/amplify/data/schemas/optimization.schema.ts`;
  `web/amplify/functions/continuous-optimization-engine/*` (3 parallel model
  streams: fast physics <1s, ROM/ML <30s, full CFD minutes).
- **Ports from:** `reference/genai-demos/amplify/functions/continuous-optimization-engine/*`,
  `.../schemas/optimization.schema.ts`.
- **AC:** loop starts/stops via GraphQL; iterations persist; CFD stream calls Slice-6 tools.

### Slice 8 — Analytics (data-lake) pack  *(deps: Slice 3, Slice 4)*
- **New:** `packs/data-lake-analytics/{pack.json, system-prompt.md}` —
  `mcpServers` = the PySpark `McpServer` (Slice 3 seed) **plus the existing
  `"S3 Filesystem Tools"` McpServer** (so the agent has ListFiles/ReadFile/UploadFile).
  Prompt ports the PySpark + `/artifacts` guidance from
  `reference/genai-demos/cdk/lib/seed-data-construct.ts` (~L16-45).
- **Deploy:** `./scripts/deploy-pack.sh data-lake-analytics`.
- **AC:** `invokeAgent` with the analytics slug runs query→plot→artifact-render.
  Note the pack URL is sandbox-specific (`custom.agentcore_gateway_endpoint`).

### Slice 9 — HPC fracing operations pack  *(deps: Slice 6, Slice 4)*
- **New:** `packs/hpc-fracing-operations/{pack.json, system-prompt.md}` —
  `mcpServers` = the CFD `McpServer` + `"S3 Filesystem Tools"` (+ optionally the
  PySpark one). Prompt ports the **full** fracing prompt from
  `reference/genai-demos/cdk/lib/seed-data-construct.ts` (~L16-205): screen-out
  thresholds, Tier 1-4 recommendations, mandatory financial justification,
  pressure-curve guidelines, `/artifacts` rendering rules.
- **Deploy:** `./scripts/deploy-pack.sh hpc-fracing-operations`.
- **AC:** `invokeAgent` with the fracing slug submits a treatment plan → tiered
  recommendations with financial justification.

### Slice 10 — Docs
- **New/Modify:** `docs/analytics-agent.md`, `docs/hpc-fracing-agent.md`; update
  `docs/use-case-packs.md` (new packs + sandbox-URL caveat) and the
  s3-tools/`UploadFile` doc. Port background from
  `reference/genai-demos/docs/hpc/*.md`.

## Key risks

1. **Always-on PCS login node + FSx-Lustre cost** — gate Slices 5/6 opt-in;
   smallest FSx; document teardown (dev phase allows deletion).
2. **Athena-for-Spark availability** — PySpark v3 not in every region/account;
   cold start 40-90s. Verify region first; bounded-wait submit; clear `{error}`.
3. **Long-running tools vs. Lambda ceiling** — submit→poll→results split; agent polls ~15s.
4. **Sandbox-specific gateway URL in packs** — document refresh from
   `web/amplify_outputs.json` (`custom.agentcore_gateway_endpoint`).
5. **Spark-execution-role IAM** — artifacts uploaded by the Spark role, not the
   Lambda; missing `PutObject` on `files/artifacts/*` fails silently.
6. **Iceberg/Glue/federation `EngineConfiguration` + AthenaJDBC.jar** — must exist
   at `s3://<bucket>/athena-jars/` or drop federation for the demo.
