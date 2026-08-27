# CFD Simulation Performance Optimization

## Baseline (before optimizations)

Transient pimpleFoam, 3-stage pumping schedule, 4,000-cell mesh:
- Node spin-up: ~3–4 min
- Solver (pimpleFoam): ~6 min
- Post-processing (reconstructPar + foamToVTK): ~8 min
- Metrics calculation: ~1 min
- **Total: ~18–19 min**

## Optimizations Applied

### 1. Skip foamToVTK for transient simulations
VTK files are not used for time-series metrics — `calculate_metrics.py` reads OpenFOAM field files directly. Removed `foamToVTK` step from the transient Slurm script.

**File:** `amplify/functions/cfd-simulation-manager/submitCfdSimulation.ts`

### 2. Reduce write frequency
Changed `writeInterval` from `shortestStageDuration / 2` to `shortestStageDuration` (one write per stage instead of two).

**File:** `amplify/functions/cfd-simulation-manager/submitCfdSimulation.ts`

### 3. Cap MPI ranks for small meshes
For a 4,000-cell mesh, 64 MPI processes means only ~63 cells per rank — MPI communication overhead dominates. Capped `idealProcs` at 8 for transient sims.

**File:** `amplify/functions/cfd-simulation-manager/submitCfdSimulation.ts`

### 4. Add pimpleFoam to AMI CORE_SOLVERS
Added `pimpleFoam` to the `CORE_SOLVERS` list in the OpenFOAM install script so it gets baked into the AMI. The Slurm script now tries the AMI path first, falls back to `/fsx/bin/pimpleFoam`.

**Files:** `packer/scripts/install-openfoam.sh`, `submitCfdSimulation.ts`

### 5. Cluster scales to zero (cost optimization)
Compute nodes keep `minCount: 0` so the cluster scales to zero when idle. Node spin-up adds ~3–4 min per cold-start job, but eliminates idle compute costs (~$0.50–1.00/hr per node).

**File:** `amplify/custom/parallelClusterRealTime.ts` (unchanged — already configured)

---

## Measured Results (Job #30, 2026-04-01)

3-stage pumping schedule (pad/slurry/flush, 900s total), 4,000-cell mesh, 8 MPI ranks:

| Phase | Baseline | Optimized | Savings |
|-------|----------|-----------|---------|
| Node spin-up | 3–4 min | 3–4 min (cold) | 0 (scale-to-zero) |
| blockMesh + decomposePar | ~1 min | ~24s | ~36s |
| pimpleFoam (solver) | ~6 min | 3s | ~5 min 57s |
| reconstructPar | ~5 min | ~50s | ~4 min 10s |
| foamToVTK | ~3 min | skipped | ~3 min |
| Metrics + S3 upload | ~1 min | ~10s | ~50s |
| **Total (excl. spin-up)** | **~15 min** | **~1.5 min** | **~13.5 min (90%)** |
| **Total (incl. cold start)** | **~19 min** | **~5 min** | **~14 min (74%)** |

Key observations:
- pimpleFoam went from ~6 min to 3s — the MPI rank cap (8 vs 64) eliminated massive communication overhead for this small mesh
- No foamToVTK saved ~3 min of post-processing
- reconstructPar still processes ~150 timesteps (adaptive timestepping writes more frequently than the configured writeInterval) but completes quickly due to the small mesh

---

## Remaining Optimization Opportunities

### Write frequency (moderate effort)
The adaptive timestepper writes at every timestep (~150 writes) despite `writeInterval=300s`. This is because OpenFOAM's `adjustableRunTime` interacts with the `scalarTransport` function object. For larger meshes, reducing writes to 3 per simulation (one per stage) would further cut reconstructPar time.

### AMI rebuild (one-time effort)
Rebuild the AMI with `pimpleFoam` baked in to eliminate the `/fsx/bin` fallback:
```bash
./scripts/build-openfoam-ami.sh
```
Then update the AMI ID in `amplify/custom/parallelClusterRealTime.ts`.

### Simulation tiers (feature work)
Offer Fast (1,000 cells), Standard (4,000 cells), and High-Fidelity (16,000 cells) mesh resolutions. Fast tier with warm nodes could achieve sub-2-minute simulations.
