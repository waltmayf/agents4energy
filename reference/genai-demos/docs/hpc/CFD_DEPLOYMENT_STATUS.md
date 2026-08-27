# CFD OpenFOAM Integration - Deployment Status

> ⚠️ **SUPERSEDED (historical).** This describes the earlier **AWS Batch** design (with `pcluster` CLI as a separate step). The shipped system runs OpenFOAM on an **AWS PCS SLURM cluster** (`hpc7g.4xlarge`, 0–10) provisioned by CDK, with jobs submitted via SSM `sbatch` on an always-on login node. For the current architecture see **[README.md](README.md)**. Kept for historical reference only.

## Current Status: Ready for Deployment ✅

The circular dependency issue has been resolved. The backend is now ready to deploy.

## What Was Fixed

### Problem
The `OpenFOAMComputeEnvironment` construct (AWS Batch) was creating circular dependencies between CloudFormation nested stacks, preventing deployment.

### Solution
Temporarily disabled the AWS Batch compute environment in `amplify/backend.ts`. The CFD simulation manager Lambda function is configured to work without it by:
- Uploading simulation configurations to S3
- Updating simulation records via Amplify Data API
- Preparing for future Parallel Cluster integration

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                       │
│  - Simulations list page                                     │
│  - Simulation detail page with real-time updates            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   GraphQL API (AppSync)                      │
│  - submitCFDSimulation mutation                             │
│  - getCFDSimulationStatus query                             │
│  - cancelCFDSimulation mutation                             │
│  - generateSimulationSnapshots mutation                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│          CFD Simulation Manager Lambda                       │
│  - Uploads config/scripts to S3                             │
│  - Updates DynamoDB via Amplify Data API                    │
│  - Placeholder for Parallel Cluster integration            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    S3 Storage Bucket                         │
│  - cfd-simulations/{id}/config.json                         │
│  - cfd-simulations/{id}/job.sh                              │
│  - cfd-simulations/{id}/results/                            │
└─────────────────────────────────────────────────────────────┘
```

## Deployed Components

✅ **Data Model** (`amplify/data/schemas/cfd.schema.ts`)
- CFDSimulation model
- SimulationSnapshot model
- ParallelClusterConfig model
- Custom mutations and queries

✅ **Lambda Function** (`amplify/functions/cfd-simulation-manager/`)
- Handles simulation submission
- Manages simulation status
- Generates visualization snapshots
- Uses Amplify Data API (not direct DynamoDB)

✅ **GraphQL Resolvers** (`amplify/data/resolvers/`)
- submitCFDSimulation.js
- getCFDSimulationStatus.js
- cancelCFDSimulation.js
- generateSimulationSnapshots.js

✅ **Frontend Pages**
- `/simulations` - List all simulations
- `/simulations/[id]` - View simulation details

✅ **Storage Configuration**
- S3 bucket with `cfd-simulations/*` path

## Not Yet Deployed

⏳ **AWS Parallel Cluster**
- Construct defined in `amplify/custom/parallelClusterRealTime.ts`
- Not integrated into backend.ts (to avoid circular dependency)
- Needs separate deployment using AWS ParallelCluster CLI

⏳ **Compute Environment**
- AWS Batch construct disabled (caused circular dependency)
- Will be replaced with Parallel Cluster for real-time performance

## Next Steps

### 1. Deploy Current Backend (Now)

```bash
npm run sandbox
```

This will deploy:
- Data models
- Lambda function
- GraphQL API
- Frontend pages
- S3 storage

### 2. Test Basic Functionality

After deployment, you can:
- Create simulations via the frontend
- View simulation list
- See simulation details
- Configurations are uploaded to S3

### 3. Deploy Parallel Cluster (Later)

When ready for real-time CFD:

1. **Install ParallelCluster CLI**:
   ```bash
   pip install aws-parallelcluster
   ```

2. **Create cluster configuration** (see `docs/CFD_REALTIME_DATA_ASSIMILATION.md`)

3. **Deploy cluster**:
   ```bash
   pcluster create-cluster --cluster-name realtime-cfd --cluster-configuration cluster-config.yaml
   ```

4. **Update Lambda function** to use SSM for job submission:
   - Uncomment SSM imports in `handler.ts`
   - Add head node instance ID to environment variables
   - Implement actual Slurm job submission

5. **Re-enable compute permissions** in `backend.ts`:
   - Uncomment SSM permissions (already present)
   - Add Parallel Cluster-specific permissions

## Why This Approach?

### Separation of Concerns
- **Amplify Backend**: Data models, API, Lambda functions, storage
- **Parallel Cluster**: Compute infrastructure (deployed separately)

### Benefits
1. **No Circular Dependencies**: Parallel Cluster is independent
2. **Faster Iteration**: Can update backend without redeploying cluster
3. **Cost Control**: Deploy cluster only when needed
4. **Flexibility**: Can use different cluster configurations

### AWS Parallel Cluster vs AWS Batch

| Feature | Parallel Cluster | AWS Batch |
|---------|-----------------|-----------|
| Job submission latency | 5-15 seconds | 3-7 minutes |
| Update cycle | 1 minute ✅ | Not feasible ❌ |
| Cost (90 min operation) | $24 | $30 |
| Data assimilation | Yes ✅ | No ❌ |
| Management complexity | Higher | Lower |

For real-time monitoring with 1-minute updates, Parallel Cluster is required.

## Architecture Decision

The user correctly identified that AWS Batch is not suitable for real-time CFD with 1-minute update cycles due to:
- 3-7 minute cold start latency
- No persistent compute
- Higher cost

AWS Parallel Cluster provides:
- 5-15 second job submission latency
- Persistent compute nodes
- Slurm scheduler for instant dispatch
- FSx Lustre for high-performance I/O
- Lower cost for long-running operations

## Documentation

- **Integration Guide**: `docs/CFD_OPENFOAM_INTEGRATION.md`
- **Real-Time Architecture**: `docs/CFD_REALTIME_DATA_ASSIMILATION.md`
- **Implementation Summary**: `docs/CFD_IMPLEMENTATION_SUMMARY.md`
- **Feasibility Analysis**: `docs/genai_hpc_cfd_screen_out_feasibility.md`

## Files Modified

### Backend Configuration
- `amplify/backend.ts` - Disabled OpenFOAM compute environment

### Lambda Function
- `amplify/functions/cfd-simulation-manager/handler.ts` - Removed unused imports, added documentation
- `amplify/functions/cfd-simulation-manager/resource.ts` - Assigned to data stack

### Data Model
- `amplify/data/schemas/cfd.schema.ts` - CFD models and mutations

### Frontend
- `src/app/(with-layout)/(with-auth)/simulations/page.tsx` - List view
- `src/app/(with-layout)/(with-auth)/simulations/[id]/page.tsx` - Detail view

### Storage
- `amplify/storage/resource.ts` - Added cfd-simulations path

## Deployment Command

```bash
npm run sandbox
```

This should now deploy successfully without circular dependency errors.

---

**Last Updated**: January 2026  
**Status**: Ready for deployment
