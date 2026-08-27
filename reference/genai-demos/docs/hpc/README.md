# HPC / CFD Platform — Overview

**This is the authoritative overview of how HPC is deployed and how the agent interacts with it.** It supersedes the older, drifting docs in this directory. Where another doc conflicts with this one, this one is correct (it is checked against the CDK source). Individual deep-dive docs are linked at the bottom.

**Last verified against code:** 2026-08-03 (against `amplify/custom/parallelClusterRealTime.ts`, `cdk/lib/hpc-stack.ts`, and the `amplify/functions/*` Lambdas).

---

## What this is

An HPC backend that runs **OpenFOAM CFD simulations** on an **AWS PCS (Parallel Computing Service)** SLURM cluster, so the agent can evaluate fracturing treatment plans, run ensemble/hypothesis simulations, and assess screen-out risk. The agent never touches the cluster directly — it calls AppSync GraphQL, and Lambdas drive the cluster.

---

## Deployment topology

HPC is an **independent CDK stack**, deployed separately from the AgentCore stack.

| Layer | Where | Notes |
|-------|-------|-------|
| Stack definition | [cdk/lib/hpc-stack.ts](../../cdk/lib/hpc-stack.ts) | Imports the VPC via `Fn.importValue('DemoVpcId')`; instantiates the cluster construct. |
| Cluster construct | [amplify/custom/parallelClusterRealTime.ts](../../amplify/custom/parallelClusterRealTime.ts) | The real infra: PCS cluster, node groups, FSx, S3, IAM, security groups. |
| App entrypoint | [cdk/bin/app.ts](../../cdk/bin/app.ts) | `DEPLOY_STACK=hpc` deploys only HPC; `agentcore` only AgentCore; unset deploys both. |

### Deploy

```bash
# HPC stack only
DEPLOY_STACK=hpc npx cdk deploy hpc-<sandboxId>

# Optional custom OpenFOAM compute AMI: set CUSTOM_COMPUTE_AMI_ID,
# or drop the AMI id in packer/ami-id.txt (auto-picked up by app.ts).
```

`sandboxId` is derived from `amplify_outputs.json` (`custom.rootStackName`) or the `SANDBOX_ID` env var.

---

## Cluster configuration (ground truth)

All values below come directly from `parallelClusterRealTime.ts`.

### AWS PCS cluster
- **Scheduler:** SLURM `25.05`, `slurmRest` mode `STANDARD`
- **Cluster size:** `SMALL`
- **Scale-down idle time:** `600` seconds (10 minutes) — idle compute nodes terminate after 10 min
- **Networking:** first private subnet of the imported VPC; dedicated cluster security group with all-internal-traffic ingress

### Node groups
| Group | Instance | Scaling | AMI | Purpose |
|-------|----------|---------|-----|---------|
| **Login** | `t3.medium` | **min=1, max=1 (always-on)** | x86 `ami-09f1c3a1c4da63269` | Entry point for SSM-based job submission; mounts FSx; puts SLURM binaries on PATH |
| **Compute** | `hpc7g.4xlarge` (arm64, EFA) | **min=0, max=10 (auto-scale)** | arm64 `ami-0da469976bf63c08b` default, or custom OpenFOAM AMI | Runs OpenFOAM jobs; scales to zero when idle |

> **Cost note:** the login node is always-on (~$30/month for t3.medium). It was intentionally set to `min=1` (commit `3e4d64a`, 2026-03-02) because the production submission path uses **SSM → `sbatch` on the login node**, which requires a running node. Compute cost is $0 when idle.

### FSx for Lustre
- **Capacity:** 1200 GB, `PERSISTENT_1`, 50 MB/s/TiB throughput, `LZ4` compression
- **S3 integration:** import & export path `s3://<hpcBucket>/cfd-simulations`, `autoImportPolicy: NEW_CHANGED`
- **Mount:** `/fsx` on both login and compute nodes (Lustre client installed + mounted via launch-template user data)
- **This is deployed** — not a future enhancement.

### S3
- A dedicated **HPC bucket** is created by the construct (with an FSx-service-linked-role bucket policy).
- Jobs write results to `s3://<hpcBucket>/cfd-simulations/<SLURM_JOB_ID>/results/` and FSx auto-exports `/fsx` changes back to S3.

---

## How the agent interacts with HPC

The agent tools run in the agent-server container and **only call AppSync GraphQL** (`authMode: userPool`). AppSync resolvers are Lambda-backed, and those Lambdas drive the cluster.

```
Agent tool ──GraphQL──> AppSync ──> Lambda ──(SSM RunShellScript)──> Login node ──sbatch──> SLURM
                                                                          │
                                          OpenFOAM runs on /fsx  ─────────┘
                                                                          │
                                          aws s3 cp results ──> S3 (also FSx auto-export)
                                                                          │
Agent tool ──GraphQL──> AppSync ──> Lambda ──(read S3)────────────────────┘
```

### Agent tools

| Tool | File | GraphQL op | What it does |
|------|------|-----------|--------------|
| `evaluate-treatment-plan` | [cfdSimulationTools.ts](../../cdk/lib/agent-server/src/tools/cfdSimulationTools.ts) | `submitCfdSimulation` → poll `getCfdJobStatus` → `getCfdResults` | Submits a treatment plan as a 3-D CFD sim, polls to completion (15s interval), returns optimization/risk metrics |
| `run-ensemble-simulation` | [fractureInterpretationTools.ts](../../cdk/lib/agent-server/src/tools/fractureInterpretationTools.ts) | `runEnsembleSimulation` | Fans a base plan out to 10 concurrent geological-scenario CFD sims |
| `interpret-pressure-response` | fractureInterpretationTools.ts | `interpretPressureResponse` | Matches an observed pressure curve to the ensemble |
| `run-hypothesis-simulations` | fractureInterpretationTools.ts | `runHypothesisSimulations` | Submits targeted hypothesis CFD sims (adaptive loop) |
| `start-well-operation`, `assess-screen-out-risk`, `get-latest-screen-out-prediction`, `list-well-operations`, `get-prediction-history`, `list-cfd-validation-jobs` | [screenOutTools.ts](../../cdk/lib/agent-server/src/tools/screenOutTools.ts) | respective GraphQL ops | Screen-out risk workflow. Tier 1/2 run in-Lambda (physics/ROM); Tier 3 (full CFD) is **disabled in this demo** |

### Backend cluster-access paths

There are **two** mechanisms in the repo. The agent's path is #1.

1. **SSM → login node → `sbatch` (production, used by the agent).**
   `amplify/functions/cfd-simulation-manager/`:
   - `submitCfdSimulation.ts` — generates a SLURM batch script (steady-state or transient pimpleFoam), finds the running login node by EC2 tag, and runs `sbatch` at `/opt/aws/pcs/scheduler/slurm-25.05/bin/sbatch` via SSM `AWS-RunShellScript`. Stores the SLURM job id on a `CFDSimulation` DynamoDB record.
   - `getCfdJobStatus.ts` — SSM `squeue` → `scontrol` → `sacct` → S3 result-prefix check to map job state.
   - `getCfdResults.ts` — **no cluster contact**; reads VTK/CSV/`metrics.json` directly from S3.
   - Ensemble (`ensemble-fracture-interpreter/`) fans out N `submitCFDSimulation` calls, each going through this same path.

2. **SLURM REST API over HTTP + JWT (alternate; dev/standalone only).**
   `amplify/functions/slurm-job-submitter/submitJob.ts` (`submitSlurmJob` mutation): resolves the `SLURMRESTD` endpoint via PCS `GetClusterCommand`, signs an HS256 JWT with the signing key from Secrets Manager, and POSTs to `http://<privateIp>:<port>/slurm/v0.0.43/job/submit`. **The agent tools do not call this** — only the operator scripts in `scripts/hpc/` do.

---

## Operator scripts

`scripts/hpc/` (dev/ops, not called by the agent) — see [scripts/hpc/README.md](../../scripts/hpc/README.md) and [scripts/hpc/QUICK_START.md](../../scripts/hpc/QUICK_START.md):

| Script | Path used |
|--------|-----------|
| `submitJobViaLambda.ts` | `submitSlurmJob` GraphQL → VPC Lambda → SLURM REST API |
| `submitJobViaSSM.ts` | EC2 tag lookup + SSM `sbatch` (mirrors the production path) |
| `submitSampleJob.ts`, `testJobWithResults.ts`, `sample-job.sh` | Sample/e2e job submission |
| `addFsxS3Integration.ts` | One-off FSx↔S3 wiring helper |

> Note: docs that reference `npm run hpc:submit-sample` / `hpc:submit-ssm` are stale — those npm aliases don't exist; run the `.ts` files directly (e.g. `npx tsx scripts/hpc/submitSampleJob.ts`).

---

## Deep-dive docs

Current / accurate:
- [SIMULATION_PERFORMANCE.md](SIMULATION_PERFORMANCE.md) — CFD job perf tuning (most recent, matches deployed config)
- [SLURM_REST_API_IMPLEMENTATION.md](SLURM_REST_API_IMPLEMENTATION.md) — REST API submission design
- [FSX_LUSTRE_INTEGRATION.md](FSX_LUSTRE_INTEGRATION.md) — FSx for Lustre details
- [CFD_REALTIME_DATA_ASSIMILATION.md](CFD_REALTIME_DATA_ASSIMILATION.md) — real-time data-assimilation rationale

Historical / superseded (describe the earlier AWS Batch design, kept for reference):
- [CFD_DEPLOYMENT_STATUS.md](CFD_DEPLOYMENT_STATUS.md), [CFD_IMPLEMENTATION_SUMMARY.md](CFD_IMPLEMENTATION_SUMMARY.md), [CFD_OPENFOAM_INTEGRATION.md](CFD_OPENFOAM_INTEGRATION.md)
