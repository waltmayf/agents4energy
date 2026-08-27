# AWS PCS (Parallel Computing Service) Architecture

> **See [README.md](README.md) for the authoritative, code-verified overview.** This doc has been corrected against `amplify/custom/parallelClusterRealTime.ts` but the overview is the source of truth.

## Overview

This project uses AWS PCS to run HPC workloads (CFD simulations with OpenFOAM) with a cost-optimized architecture. AWS PCS manages the SLURM control plane. A small always-on **login node** is retained as the entry point for SSM-based job submission (`sbatch`); compute nodes auto-scale from zero.

## Architecture Components

### 1. AWS PCS Cluster (`openfoam-cluster`)
- **Managed SLURM Controller**: AWS PCS runs the SLURM controller as a managed service
- **Control Plane Endpoint**: Private IP address (e.g., `10.0.2.26`) accessible within VPC
- **SLURM REST API**: HTTP endpoint on port 6820 for programmatic job submission
- **Always Available**: No compute costs when idle - AWS manages the control plane

### 2. Compute Node Group (`hpc7g-nodes`)
- **Instance Type**: `hpc7g.4xlarge` (ARM64, 16 vCPUs, 128 GB RAM, EFA networking)
- **Auto-Scaling**: 0-10 instances based on job queue
- **Cost Model**: Pay only when jobs are running
- **Launch Template**: Custom AMI with OpenFOAM pre-installed

### 3. SLURM Queue (`main-queue`)
- Routes jobs to the compute node group
- Manages job scheduling and resource allocation
- Triggers auto-scaling when jobs are submitted

## Key Architectural Benefits

### Managed Control Plane
Unlike traditional HPC clusters, AWS PCS manages the SLURM controller:
- No compute costs for the control plane when the cluster is idle
- AWS handles controller availability and updates
- SLURM REST API always accessible

Note: this deployment keeps a small always-on **login node** (t3.medium, min=1) as the entry point for the production SSM → `sbatch` submission path. Compute nodes still scale to zero.

### Cost Optimization
```
AWS PCS Cluster (this deployment):
- Control plane: Managed by AWS (no compute cost)
- Login node: t3.medium always-on = ~$30/month (SSM sbatch entry point)
- Compute nodes: $0 when idle; pay only when jobs run (auto-scale 0-10)
```

### Auto-Scaling
Jobs submitted via SLURM REST API automatically trigger compute node provisioning:
1. Job submitted to SLURM REST API
2. SLURM controller queues the job
3. AWS PCS scales compute nodes from 0 to N (max 10)
4. Nodes execute jobs
5. Nodes scale back to 0 when idle

## Job Submission Methods

### Method 1: SLURM REST API (Recommended)
**How it works:**
1. Retrieve JWT signing key from AWS Secrets Manager
2. Generate JWT token with SLURM user claims
3. POST job script to `http://<controller-ip>:6820/slurm/v0.0.43/job/submit`
4. SLURM controller queues job and triggers auto-scaling

**Advantages:**
- No persistent nodes required
- Fully programmatic (Lambda-compatible)
- Zero cost when idle
- Integrates with AWS services

**Usage:**
```bash
npm run hpc:submit-sample
```

**Implementation:** `scripts/hpc/submitSampleJob.ts`

### Method 2: SSM to Login Node (Optional)
**How it works:**
1. Scale login node group to 1
2. Use AWS Systems Manager to connect to login node
3. Run traditional `sbatch` commands
4. Scale login node back to 0 when done

**Advantages:**
- Traditional SLURM workflow
- Interactive commands (`squeue`, `scancel`, etc.)
- Familiar to HPC users

**Disadvantages:**
- Requires persistent node (~$30/month if always running)
- Manual scaling required
- Not Lambda-compatible

**Usage:**
```bash
npm run hpc:submit-ssm
```

**Implementation:** `scripts/hpc/submitJobViaSSM.ts`

## Node Group Configuration

### Login Node Group (Always-On)
```typescript
// amplify/custom/parallelClusterRealTime.ts
this.loginNodeGroup = new pcs.CfnComputeNodeGroup(this, 'LoginNodeGroup', {
  clusterId: this.cluster.attrId,
  name: 'login-nodes',
  instanceConfigs: [{ instanceType: 't3.medium' }],
  scalingConfiguration: {
    minInstanceCount: 1,  // Always-on: SSM sbatch entry point
    maxInstanceCount: 1
  },
  // ... other config
});
```

The login node is kept at **min=1** because the production submission path (used by the agent) runs `sbatch` on it via SSM `AWS-RunShellScript`, which needs a running node. It also mounts FSx at `/fsx` and puts SLURM binaries on PATH.

### Compute Node Group (Always Enabled)
```typescript
this.nodeGroup = new pcs.CfnComputeNodeGroup(this, 'HpcNodeGroup', {
  clusterId: this.cluster.attrId,
  name: 'hpc7g-nodes',
  instanceConfigs: [{ instanceType: 'hpc7g.4xlarge' }],
  scalingConfiguration: {
    minInstanceCount: 0,  // Auto-scales from 0
    maxInstanceCount: 10
  },
  // ... other config
});
```

## SLURM REST API Details

### Authentication
AWS PCS uses JWT tokens for SLURM REST API authentication:
- Signing key stored in AWS Secrets Manager
- Token includes SLURM user claims (username, UID, GID)
- Token signed with HMAC-SHA256

### Endpoint Discovery
The SLURM REST API endpoint is not available at CDK deploy time:
```typescript
// ❌ Cannot do this - endpoint not in CloudFormation
const endpoint = cluster.attrSlurmRestApiEndpoint; // Doesn't exist

// ✅ Must retrieve at runtime
const client = new PCSClient({ region: 'us-east-1' });
const response = await client.send(new GetClusterCommand({ 
  clusterIdentifier: 'pcs_qc8nb2aww7' 
}));
const endpoint = response.cluster?.networking?.slurmRestApiEndpoint;
```

### Job Submission Format
```typescript
const jobSubmission = {
  script: '#!/bin/bash\n#SBATCH --job-name=test\necho "Hello World"',
  job: {
    name: 'my-job',
    partition: 'main-queue',
    nodes: [1, 1],  // min, max nodes
    tasks: 1
  }
};

const response = await fetch(`http://${endpoint}/slurm/v0.0.43/job/submit`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-SLURM-USER-NAME': 'ec2-user',
    'X-SLURM-USER-TOKEN': jwtToken
  },
  body: JSON.stringify(jobSubmission)
});
```

## Cost Analysis

### Current Configuration (Login Node = 1, always-on)
- **Control Plane**: Managed by AWS (no compute cost)
- **Login Node**: t3.medium = ~$30/month (24/7, SSM sbatch entry point)
- **Compute Nodes**: $0 when idle, ~$3.06/hour per hpc7g.4xlarge when running
- **Storage**: FSx for Lustre (1200 GB PERSISTENT_1) + S3 costs for simulation data
- **Total Idle Cost**: ~$30/month + FSx/S3 storage

### Cost Optimization Recommendations
1. **Compute nodes auto-scale to zero** — no compute cost when no jobs run (idle timeout 600s / 10 min)
2. **Monitor compute node usage** to optimize max instance count
3. **Use Spot instances** for non-critical workloads (future enhancement)

## Deployment Configuration

### Current Settings
```json
{
  "hpc": {
    "clusterId": "pcs_qc8nb2aww7",
    "queueId": "pcs_dbkykbzbn8",
    "clusterName": "openfoam-cluster",
    "queueName": "main-queue",
    "loginNodeGroupName": "login-nodes",
    "computeNodeGroupName": "hpc7g-nodes",
    "region": "us-east-1",
    "note": "AWS PCS cluster with an always-on login node (t3.medium, min=1) and auto-scaling compute nodes (hpc7g.4xlarge, 0-10). Production submission uses SSM sbatch on the login node; SLURM REST API is an alternate path."
  }
}
```

### Scaling Login Nodes
To enable interactive access:
```bash
# Scale up
aws pcs update-compute-node-group \
  --cluster-identifier pcs_qc8nb2aww7 \
  --compute-node-group-identifier <login-node-group-id> \
  --scaling-configuration minInstanceCount=1,maxInstanceCount=1

# Scale down
aws pcs update-compute-node-group \
  --cluster-identifier pcs_qc8nb2aww7 \
  --compute-node-group-identifier <login-node-group-id> \
  --scaling-configuration minInstanceCount=0,maxInstanceCount=1
```

## Monitoring and Debugging

### Check Cluster Status
```bash
aws pcs get-cluster --cluster-identifier pcs_qc8nb2aww7
```

### Check Node Group Status
```bash
aws pcs get-compute-node-group \
  --cluster-identifier pcs_qc8nb2aww7 \
  --compute-node-group-identifier <node-group-id>
```

### View Running Instances
```bash
aws ec2 describe-instances \
  --filters "Name=tag:aws:pcs:cluster-id,Values=pcs_qc8nb2aww7" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,Tags[?Key==`NodeType`].Value|[0]]'
```

### Check Job Queue
```bash
# Requires login node or SLURM REST API
curl -H "X-SLURM-USER-NAME: ec2-user" \
     -H "X-SLURM-USER-TOKEN: $JWT_TOKEN" \
     http://<controller-ip>:6820/slurm/v0.0.43/jobs
```

## Security Considerations

### Network Access
- SLURM REST API endpoint is private (VPC only)
- Access requires VPN or bastion host
- Consider AWS PrivateLink for secure access from Lambda

### IAM Permissions
Required permissions for job submission:
- `secretsmanager:GetSecretValue` - Retrieve JWT signing key
- `pcs:GetCluster` - Get cluster configuration
- `ec2:DescribeInstances` - Find login nodes (SSM method only)
- `ssm:SendCommand` - Submit jobs via SSM (SSM method only)

### JWT Token Security
- Signing key stored in AWS Secrets Manager
- Tokens should be short-lived (5-15 minutes)
- Never log or expose JWT tokens
- Rotate signing key periodically

## Future Enhancements

1. **Spot Instances**: Use Spot for cost savings on non-critical jobs
2. **Multi-Queue**: Separate queues for different job types
3. **Job Monitoring**: CloudWatch metrics and alarms
4. **Auto-Cleanup**: Automatic cleanup of completed job data

> Already implemented (previously listed here as future work): Lambda-driven job submission (`amplify/functions/cfd-simulation-manager`, `slurm-job-submitter`) and **FSx for Lustre** high-performance shared storage with S3 import/export.

## References

- [AWS PCS Documentation](https://docs.aws.amazon.com/pcs/)
- [SLURM REST API Documentation](https://slurm.schedmd.com/rest_api.html)
- [SLURM REST API Implementation Guide](./SLURM_REST_API_IMPLEMENTATION.md)
- [HPC Scripts README](../scripts/hpc/README.md)

---

**Last Updated:** August 2026  
**Cluster ID:** `pcs_qc8nb2aww7`  
**Configuration:** Login node always-on (t3.medium, min=1), compute nodes auto-scale 0-10 (hpc7g.4xlarge), FSx for Lustre + S3 integration deployed
