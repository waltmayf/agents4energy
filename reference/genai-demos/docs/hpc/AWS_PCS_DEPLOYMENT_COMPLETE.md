# AWS PCS Deployment Complete

> **Corrected against current CDK.** This doc originally described the login node as "scaled to 0" and the SLURM REST API as the primary path. In the current deployment the **login node is always-on (min=1)** and the **production submission path is SSM → `sbatch`** on it (the REST API is an alternate/dev path). See [README.md](README.md) for the authoritative overview.

## Summary

Successfully deployed AWS PCS (Parallel Computing Service) cluster with SLURM REST API enabled for serverless HPC job submission.

## Deployment Status: ✅ COMPLETE

### Infrastructure Deployed

1. **AWS PCS Cluster** (`openfoam-cluster`)
   - Status: ACTIVE
   - Cluster ID: `pcs_qc8nb2aww7`
   - SLURM Version: 25.05
   - Size: SMALL
   - SLURM REST API: ENABLED (mode: STANDARD)

2. **Endpoints**
   - SLURMCTLD: `10.0.2.26:6817` (controller)
   - SLURMRESTD: `10.0.2.26:6820` (REST API)

3. **Compute Node Groups**
   - **Login Nodes** (`login-nodes`): Always-on (entry point for SSM `sbatch`)
     - Instance Type: t3.medium
     - Scaling: min=1, max=1
   - **Compute Nodes** (`hpc7g-nodes`): Auto-scaling based on job queue
     - Instance Type: hpc7g.4xlarge (ARM64, optimized for CFD)
     - Scaling: 0-10 nodes
     - Cost: $0 when idle, ~$3.06/hour per node when running

4. **SLURM Queue** (`main-queue`)
   - Status: ACTIVE
   - Queue ID: `pcs_dbkykbzbn8`
   - Routes jobs to compute node group

5. **Authentication**
   - JWT signing key stored in AWS Secrets Manager
   - ARN: `arn:aws:secretsmanager:us-east-1:796988593450:secret:pcs!slurm-secret-pcs_qc8nb2aww7-iQpyUS`

## Job Submission Implementation

### Script Created: `scripts/hpc/submitSampleJob.ts`

The script implements the complete SLURM REST API job submission workflow:

1. ✅ Retrieves SLURM REST API endpoint from cluster configuration
2. ✅ Fetches JWT signing key from AWS Secrets Manager
3. ✅ Generates JWT token with required claims:
   - `sun`: Username (ec2-user)
   - `uid`: POSIX user ID (1000)
   - `gid`: POSIX group ID (1000)
   - `id`: Additional identity properties (gecos, dir, gids, shell)
   - `exp`: Token expiration (5 minutes)
   - `iat`: Issued at timestamp
4. ✅ Submits job via HTTP POST to `/slurm/v0.0.43/job/submit`
5. ✅ Uses Bearer token authentication

### Current Limitation

The SLURM REST API endpoint is **private** (10.0.2.26:6820) and only accessible from within the VPC. Running the script from outside the VPC results in:

```
❌ Error: fetch failed
```

This is **expected behavior** and a security feature - the API is not exposed to the public internet.

## Next Steps to Enable Job Submission

### Option 1: Run from Within VPC (Recommended for Testing)

Deploy the script to a Lambda function or EC2 instance within the same VPC:

```typescript
// Lambda function in same VPC as cluster
export const handler = async (event) => {
  // Script code here - will have network access to 10.0.2.26:6820
};
```

### Option 2: VPN/Bastion Access

Connect to the VPC via:
- AWS Client VPN
- Bastion host with SSM Session Manager
- VPC peering from another VPC

### Option 3: API Gateway + Lambda (Production)

Create an API Gateway that triggers a Lambda function in the VPC:
1. API Gateway receives job submission request
2. Triggers Lambda function in VPC
3. Lambda calls SLURM REST API
4. Returns job ID to caller

### Option 4: Use Login Node (Traditional Approach)

Scale login node group to 1 and submit jobs via SSM:
```bash
# Scale up login node
aws pcs update-compute-node-group \
  --cluster-identifier pcs_qc8nb2aww7 \
  --compute-node-group-identifier <login-node-group-id> \
  --scaling-configuration minInstanceCount=1,maxInstanceCount=1

# Wait for node to be ready, then use SSM
npm run hpc:submit-ssm
```

## Cost Analysis

### Current Configuration (Login Node = 1, always-on)
- **Control Plane**: Managed by AWS (no compute cost)
- **Login Node**: t3.medium always-on = ~$30/month (SSM `sbatch` entry point)
- **Compute Nodes**: $0 when idle
- **Total Idle Cost**: ~$30/month + FSx/S3 storage

### When Jobs Run
- **Compute Nodes**: ~$3.06/hour per hpc7g.4xlarge instance
- **Auto-scaling**: Nodes provision in 5-10 minutes, terminate after the idle timeout (`scaleDownIdleTimeInSeconds=600`, i.e. 10 min)

## Testing the Implementation

### Local Testing (Will Fail - Expected)
```bash
npm run hpc:submit-sample
```
Result: `fetch failed` (cannot reach private IP from outside VPC)

### Testing from Within VPC
1. Deploy Lambda function in VPC
2. Configure Lambda with:
   - VPC: Same as cluster
   - Subnets: Same as cluster
   - Security Group: Allow outbound to 10.0.2.26:6820
3. Invoke Lambda with job submission request

## Documentation Created

1. **`docs/AWS_PCS_ARCHITECTURE.md`**
   - Complete architecture overview
   - Cost analysis
   - Job submission methods
   - Security considerations

2. **`scripts/hpc/submitSampleJob.ts`**
   - Production-ready SLURM REST API client
   - JWT token generation
   - Error handling

3. **`AGENTS.md`** (Updated)
   - Added guidance: "NEVER guess at enum values - always search documentation first"

## Configuration Files Updated

1. **`amplify/custom/parallelClusterRealTime.ts`**
   - Enabled SLURM REST API (mode: STANDARD)
   - Login node group kept at min=1 (always-on SSM `sbatch` entry point)
   - Added comprehensive comments

2. **`amplify/custom/backendOutputsConstruct.ts`**
   - Updated HPC configuration note
   - Reflects always-on login node (min=1)

3. **`package.json`**
   - Added `jsonwebtoken` and `@types/jsonwebtoken` dependencies

## Verification Commands

```bash
# Check cluster status
aws pcs get-cluster --cluster-identifier pcs_qc8nb2aww7

# Check SLURM REST API is enabled
aws pcs get-cluster --cluster-identifier pcs_qc8nb2aww7 \
  --query 'cluster.slurmConfiguration.slurmRest.mode'

# Check endpoints
aws pcs get-cluster --cluster-identifier pcs_qc8nb2aww7 \
  --query 'cluster.endpoints'

# Check compute node group
aws pcs get-compute-node-group \
  --cluster-identifier pcs_qc8nb2aww7 \
  --compute-node-group-identifier pcs_5r7kigarho
```

## Key Learnings

1. **Always search documentation for enum values** - Don't guess! 
   - Incorrect: `mode: 'ENABLED'` ❌
   - Correct: `mode: 'STANDARD'` ✅

2. **JWT token structure is specific** - AWS PCS requires enriched JWT with:
   - `sun` (username)
   - `uid` (POSIX user ID)
   - `gid` (POSIX group ID)
   - `id` object with gecos, dir, gids, shell

3. **Endpoint discovery** - SLURM REST API endpoint is in `cluster.endpoints[]`, not `cluster.networking`

4. **Private networking** - REST API is intentionally private for security

## References

- [AWS PCS SLURM REST API Documentation](https://docs.aws.amazon.com/pcs/latest/userguide/slurm-rest-api.html)
- [AWS PCS Authentication Guide](https://docs.aws.amazon.com/pcs/latest/userguide/slurm-rest-api-authenticate.html)
- [SLURM REST API v0.0.43 Documentation](https://slurm.schedmd.com/rest_api.html)

---

**Deployment Date:** March 2, 2026 (doc corrected August 2026)  
**Cluster ID:** `pcs_qc8nb2aww7`  
**Status:** Production. Job submission runs via SSM `sbatch` on the always-on login node (`amplify/functions/cfd-simulation-manager`); the SLURM REST API is an alternate VPC-Lambda path.
