# HPC fracing operations agent

`packs/hpc-fracing-operations/` — a use-case-pack agent (slug `hpc-fracing-operations`) that
submits hydraulic-fracturing treatment plans to a real HPC/CFD simulation pipeline (AWS PCS +
Slurm + FSx-Lustre + OpenFOAM) and returns tiered screen-out-risk recommendations, each backed
by a mandatory quantified financial justification. Part of epic #498; shipped as CFD tools in
#504 (slice 6) and this pack in #507/#523 (slice 9).

## Tools

- **CFD Simulation Tools** — `SubmitCfdSimulation` / `GetCfdJobStatus` / `GetCfdResults`, a
  submit → poll → results trio (poll roughly every 15s; never assume a result is ready
  immediately after submit — jobs run minutes, not seconds).
- **S3 Filesystem Tools** — `ListFiles` / `ReadFile` / `UploadFile` / `ApplyDiff` / `DeleteFile`
  for treatment-plan inputs, saved CFD results, and rendered artifacts under
  `files/artifacts/` (see [`docs/agent-filesystem.md`](agent-filesystem.md)).
- **Athena PySpark Tools** (optional) — `SubmitPySpark` / `GetPySparkStatus` /
  `GetPySparkResults` for ad-hoc pressure-curve, ensemble, or historical-offset-well analysis
  alongside the CFD tools (same tools the [analytics agent](analytics-agent.md) uses).

## PCS / Slurm / FSx architecture

The agent never touches the cluster directly — the `CfdToolsFn` Lambda drives it via SSM:

```
Agent tool ─(gateway)─> CfdToolsFn Lambda ─SSM RunShellScript─> PCS login node ─sbatch─> Slurm
                                                                       │
                                                OpenFOAM job runs on /fsx (compute nodes)
                                                                       │
                                        FSx auto-exports /fsx -> S3 (cfd-simulations/<jobId>/results/)
                                                                       │
Agent tool ─(gateway)─> CfdToolsFn Lambda ─(read S3 metrics.json)──────┘
```

This ports the "SSM → login node → `sbatch`" production path from
`reference/genai-demos/docs/hpc/*.md` (that repo's older AWS-Batch-based docs and its
alternate SLURM-REST-API path are **not** used here — this pack's Lambda always goes through
SSM against the login node, matching `reference/genai-demos/docs/hpc/README.md`'s "agent's
path is #1").

`web/amplify/constructs/realTimeParallelCluster/` (epic Slice 5) provisions:

| Component | Config |
|---|---|
| **PCS cluster** | Slurm `25.05`, `slurmRest` `STANDARD`, size `SMALL` |
| **Login node group** | `t3.medium`, always-on (`min=1, max=1`) — SSM/`sbatch` needs a running node to submit against |
| **Compute node group** | `hpc7g.4xlarge` (arm64, EFA), scale-to-zero (`min=0, max=10`), idle nodes terminate after 600s |
| **FSx for Lustre** | 1200 GB `PERSISTENT_1`, `LZ4` compression, mounted `/fsx` on login + compute; S3 import/export path `s3://<hpcBucket>/cfd-simulations` with `autoImportPolicy: NEW_CHANGED` |
| **HPC bucket** | Dedicated S3 bucket; jobs write to `cfd-simulations/<jobId>/results/`, FSx auto-exports there |

The `CfdToolsFn` Lambda (`web/amplify/functions/cfd-tools/handler.ts`):

1. **`SubmitCfdSimulation`** — validates the treatment plan (see below), generates a Slurm
   batch script (`cfd-slurm-script.ts` — steady `simpleFoam` if the plan has no `stages`,
   transient `pimpleFoam` if it does), finds the login node by its `PCS-Login-Node` EC2 tag,
   discovers the cluster's Slurm partition at submit time (PCS clusters don't have a fixed
   partition name), and runs `sbatch` via SSM `AWS-RunShellScript`. Parses `Submitted batch
   job N` from stdout and returns `{success, jobId, status: "PENDING"}`.
2. **`GetCfdJobStatus`** — SSM `squeue` (live jobs) → falls back to `sacct` (finished jobs) →
   falls back to an S3 results-prefix check, mapping the raw Slurm state (`PENDING`,
   `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, and their sub-states) to one of those five
   normalized statuses.
3. **`GetCfdResults`** — once `COMPLETED`, reads `metrics.json` from
   `s3://<hpcBucket>/cfd-simulations/<jobId>/results/`, returning
   `proppantPlacementEfficiency` / `fractureGeometryScore` / `placementUniformity` and
   `screenOutRisk` / `concentrationRisk` / `velocityRisk` / `pressureRisk` plus a confidence
   score. Also best-effort mirrors a `results.json` summary into
   `files/artifacts/cfd-simulations/<jobId>/results.json` in the `agentWorkspace` bucket so it
   renders via the same `/artifacts/...` iframe path the PySpark tools use — non-fatal if that
   write fails.

All three tools return `{success: false, error}` rather than throwing, matching the
`s3-tools`/`graph-traverse` gateway-target convention (see
[`docs/hpc-analytics-agents-epic.md`](hpc-analytics-agents-epic.md#the-agents4energy-gateway-target-tool-pattern-every-tool-slice-follows-this)).

## The `enableHpc` CDK context flag — cost/provisioning gate

The PCS login node and FSx-Lustre filesystem run **24/7 once deployed** — there is no
scale-to-zero for the login node (SSM/`sbatch` submission needs it running), and FSx-Lustre
bills for provisioned capacity regardless of use. To avoid a normal `pnpm deploy` silently
paying for that, the entire HPC cluster stack is opt-in, gated in
[`web/amplify/backend.ts:1262`](../web/amplify/backend.ts):

```ts
const enableHpcContext = backend.stack.node.tryGetContext('enableHpc');
const enableHpc = enableHpcContext === true || enableHpcContext === 'true';

if (enableHpc) {
  // hpc-cluster stack: dedicated VPC, RealTimeParallelCluster (PCS + FSx)
  // cfd-tools stack (nested, also requires AGENTCORE_GATEWAY_ID): CfdToolsFn + gateway target + McpServer seed
}
```

- **Off by default** — a normal `pnpm deploy` (and the credential-free `pnpm test:synth` gate)
  never creates the `hpc-cluster` or `cfd-tools` stacks, so CI and everyday sandbox deploys pay
  nothing for HPC.
- **Turn it on** with a CDK context flag: `npx ampx sandbox --once -- --context enableHpc=true`
  (or the equivalent flag on whatever `cdk`/`ampx` invocation your deploy script wraps).
- Both the `hpc-cluster` stack and the nested `cfd-tools` stack are their own
  `backend.createStack(...)` sinks (not `agentStack`) — `cfd-tools` additionally requires
  `AGENTCORE_GATEWAY_ID` to be set (same reasoning as the `s3-tools`/`graph-traverse` gateway
  targets: no gateway, no target to register).
- The `CFD Simulation Tools` `McpServer` row this pack references is **only seeded** when the
  backend is deployed with `enableHpc=true` — deploying this pack against a sandbox that
  doesn't have the flag on will create the `Agent`/join rows, but the CFD tools won't be
  reachable until a follow-up deploy turns the flag on.

See [`docs/hpc-analytics-agents-epic.md`](hpc-analytics-agents-epic.md#slice-5--pcsslurmfsx-cluster-construct-no-deps-costly--opt-in-gated)
(Slices 5-6) and [`docs/autonomous-epic-delivery.md`](autonomous-epic-delivery.md) for how this
interacts with the `PROJECT_PHASE` gate on destructive/costly actions.

## Treatment-plan inputs

`SubmitCfdSimulation` validates the plan against `web/amplify/functions/cfd-tools/cfd-types.ts`
before submitting anything:

| Field | Range | Notes |
|---|---|---|
| `injectionRate` | 0.1 - 0.5 m³/s | required |
| `proppantConcentration` | 0.1 - 0.4 (volume fraction) | required |
| `fluidViscosity` | 0.01 - 0.1 Pa·s | required |
| `treatingPressure` | > 0 | required |
| `fractureLengthM`, `fractureWidthMm` | > 0 if provided | optional |
| `stages[]` | `{stageType: 'pad'\|'slurry'\|'flush', startTimeSeconds, endTimeSeconds, pumpRateBblMin, proppantConcentrationPpg, fluidViscosityCp}` | optional — presence selects the transient `pimpleFoam` solver over the steady `simpleFoam` one; stages must be contiguous (`stages[i].startTimeSeconds === stages[i-1].endTimeSeconds`) and each stage's own fields must be positive |

Any validation failure returns `{success: false, error: "Treatment plan validation failed: ..."}`
listing every violated rule, rather than submitting a doomed job.

## Tiered recommendation structure with financial justification

The system prompt (`packs/hpc-fracing-operations/system-prompt.md`) ports the full fracing
prompt from `reference/genai-demos/cdk/lib/seed-data-construct.ts`, adapted to this repo's
actual tool names. Its core structure:

1. **Screen-out risk thresholds** — a calibrated LOW (0-25%) / MODERATE (25-50%) / HIGH
   (50-75%) / CRITICAL (>75%) probability scale, keyed off pressure percentile vs. an
   ensemble/historical baseline, dP/dt trend (accelerating vs. decelerating), step-change
   magnitude, and treating pressure as a fraction of MAOP/closure pressure.
2. **Tiered recommendations**, one tier per risk level:
   - **Tier 1 — Enhanced Monitoring** (LOW): parameters to watch + escalation thresholds, no
     operational change.
   - **Tier 2 — Minor Adjustment** (MODERATE): 5-15% parameter tweak + contingency plan.
   - **Tier 3 — Major Revision** (HIGH): >25% parameter reduction / stage abort, full financial
     justification required, compared against "continue + monitor."
   - **Tier 4 — Emergency Action** (CRITICAL): immediate well-control action, safety/equipment
     rationale, post-action diagnostic plan.
   - The model defaults to the lowest tier the data supports and only escalates if a tier's
     threshold criteria are actually met.
3. **Mandatory financial justification** — non-negotiable for *any* treatment-plan-parameter
   change recommendation (proppant concentration, pump rate, fluid volume, stage timing, mesh
   size, etc.). Six required sections: immediate cost delta (proppant/fluid/pump-time/rig,
   original vs. revised), risk-mitigation value (failure-mode probability × cost avoided),
   production impact (peak IP, 6-month cumulative, EUR, NPV with explicit reservoir
   assumptions), a risk-adjusted NPV scenario table (success / recoverable failure / severe
   failure), a total financial impact rollup, and a sensitivity analysis across low/base/high
   assumptions. Baseline cost assumptions are seeded in the prompt (slickwater ~$5/bbl, 20/40
   mesh proppant ~$300/ton, rig ~$100k/day, coil-tubing remediation $750k-$1.5M) and adjusted
   for the specific well's parameters when available.
4. **Pressure-curve interpretation guidelines** and an **uncertainty-acknowledgment** protocol
   (state confidence level explicitly, list key assumptions, suggest validation steps) — both
   guard against over-reacting to normal early-treatment pressure behavior or a single
   in-band ensemble measurement.

## Response rendering

Same `/artifacts/<subdir>/...` iframe convention as the [analytics agent](analytics-agent.md):
plots go in `<iframe srcdoc="...">` (one plot per iframe, no narrative text inside), everything
else — alerts, tables, recommendations — is markdown outside the iframe. Files a CFD or PySpark
tool wrote under `files/artifacts/<subdir>/...` are referenced as
`<iframe src="/artifacts/<subdir>/...">`, never markdown image syntax.

## Deploying and known limitations

Deploy with `./scripts/deploy-pack.sh hpc-fracing-operations` — subject to the same
sandbox-specific gateway-URL caveat as every other pack (see
[`docs/use-case-packs.md`](use-case-packs.md)), plus the `enableHpc` gate above.

As of PR #523 (Slice 9), this pack shipped **without a live end-to-end verification**: the
authoring environment had no deployed backend/AWS credentials, so neither
`./scripts/deploy-pack.sh hpc-fracing-operations --dry-run` nor a live `invokeAgent`
submit → tiered-recommendation run had been exercised. Before relying on this pack in a given
sandbox, confirm `enableHpc=true` was deployed, the `CFD Simulation Tools` `McpServer` row has
a live `gatewayTargetId` (the same failure mode #524 hit for the PySpark tools), and run a real
treatment-plan submission end to end.
