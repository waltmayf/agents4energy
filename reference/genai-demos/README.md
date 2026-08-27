# genai-demos port reference (read-only)

This directory is a **read-only vendored snapshot** of the relevant source from
the sibling `genai-demos` repo, checked in so that cold cloud agents (the
`@agentcore-claude` workers, which only clone *this* repo) have the material to
port from when delivering the **HPC Operations + Analytics use-case-pack agents**
epic. See [`docs/hpc-analytics-agents-epic.md`](../../docs/hpc-analytics-agents-epic.md)
for the design and the slice-by-slice mapping of these files onto agents4energy.

**Do not deploy or import any of this directly.** genai-demos runs its tools as
Vercel-AI-SDK `tool()` objects inside its own AgentCore runtime; agents4energy
runs tools as **Lambda-backed AgentCore Gateway targets**. The AWS-service logic
(Athena Spark, AWS PCS/Slurm, SSM `sbatch`, FSx→S3, the injected Python) ports
over; the tool-registration harness does **not**. Each epic slice re-shapes the
logic into the agents4energy gateway-target pattern — read the design doc.

Nothing under `reference/` is part of the build. If a lint/typecheck config
tries to include it, exclude it.

## What's here

| Path | Ports to (agents4energy) |
|---|---|
| `cdk/lib/tools/athenaPySparkTool.ts`, `cdk/lib/tools/python/{sessionSetup,preExecution,postExecution}.py`, `cdk/lib/tools/python/loadScript.ts`, `cdk/lib/tools/toolUtils.ts`, `cdk/lib/tools/s3Toolbox.ts` | Athena PySpark tool (Slice 3) |
| `cdk/lib/agentcore-stack.ts` (Athena workgroup ~L420-442) | PySpark workgroup + Spark role (Slice 2) |
| `src/lib/htmlPreprocessing.ts` (~L479-488), `src/app/file/page.tsx` | Frontend `/artifacts` rendering (Slice 4) |
| `cdk/lib/hpc-stack.ts`, `amplify/custom/parallelClusterRealTime.ts` | PCS/Slurm/FSx cluster (Slice 5) |
| `cdk/lib/tools/cfdSimulationTools.ts`, `amplify/functions/cfd-simulation-manager/*`, `amplify/data/schemas/cfd.schema.ts`, `amplify/functions/slurm-job-submitter/*`, `amplify/data/schemas/slurm.schema.ts` | CFD submit/poll/results tools (Slice 6) |
| `amplify/functions/continuous-optimization-engine/*`, `amplify/data/schemas/optimization.schema.ts` | Continuous-optimization loop (Slice 7) |
| `cdk/lib/seed-data-construct.ts` | Pack system prompts (Slices 8, 9) |
| `cdk/lib/tools/{screenOutTools,fractureInterpretationTools}.ts`, `docs/hpc/*.md` | Domain background (fracing agent) |
