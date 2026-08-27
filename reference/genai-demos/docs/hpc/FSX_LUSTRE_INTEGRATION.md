# FSx for Lustre Integration with AWS PCS

> **Corrected against current CDK** (`amplify/custom/parallelClusterRealTime.ts`). Two things had drifted: (1) the S3 import/export path is **`s3://<bucket>/cfd-simulations`**, not `hpc-jobs/`; (2) the FSx↔S3 Data Repository Association is **already deployed** (`autoImportPolicy: NEW_CHANGED`), not a future step. Also note the HPC construct now lives in its own **`HpcStack`** that imports the VPC via `Fn.importValue`, not in the Amplify storage stack. See [README.md](README.md).

## Overview

FSx for Lustre provides high-performance shared storage for the AWS PCS cluster with automatic S3 integration. This enables:

- **High Performance**: Hundreds of GB/s throughput for parallel workloads
- **S3 Integration**: Automatic data synchronization with S3
- **Shared Storage**: All cluster nodes access the same filesystem at `/fsx`
- **Persistent Storage**: Data persists across job executions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AWS PCS Cluster                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ Login Node   │  │ Compute Node │  │ Compute Node │     │
│  │              │  │              │  │              │     │
│  │  /fsx mount  │  │  /fsx mount  │  │  /fsx mount  │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │              │
│         └─────────────────┼─────────────────┘              │
│                           │                                │
└───────────────────────────┼────────────────────────────────┘
                            │
                            │ Lustre Protocol (988)
                            │
                    ┌───────▼────────┐
                    │  FSx for       │
                    │  Lustre        │
                    │  1200 GiB      │
                    │  PERSISTENT_1  │
                    └───────┬────────┘
                            │
                            │ (Manual sync or
                            │  Data Repository
                            │  Association)
                            │
                    ┌────────────────────┐
                    │  S3 Bucket         │
                    │  cfd-simulations/  │
                    └────────────────────┘
```

## Configuration

### FSx for Lustre Settings

- **Deployment Type**: PERSISTENT_1 (cost-effective persistent storage)
- **Storage Capacity**: 1200 GiB (minimum for PERSISTENT_1)
- **Throughput**: 50 MB/s per TiB
- **Compression**: LZ4 enabled to save space
- **Mount Point**: `/fsx` on all cluster nodes
- **S3 Integration**: Manual sync or Data Repository Association (see below)

### S3 Integration

FSx for Lustre is configured with automatic S3 integration using `importPath` and `exportPath`. This is now possible because the HPC construct is instantiated in the storage stack (same stack as the S3 bucket), avoiding CloudFormation circular dependencies.

**Automatic Sync Features:**
- **Import Path**: `s3://bucket/cfd-simulations` → Files in S3 are visible in `/fsx/`
- **Export Path**: `s3://bucket/cfd-simulations` → Files written to `/fsx/` sync to S3
- **Auto Import Policy**: NEW_CHANGED → New or changed S3 files automatically appear in FSx
- **Lazy Loading**: Files are loaded from S3 on first access (not all at mount time)

**Additional Options:**
1. **Manual Sync**: Use `aws s3 sync` for immediate sync
2. **HSM Archive**: Use Lustre's HSM commands for selective export

### Security

- Dedicated security group for FSx
- Lustre traffic (TCP port 988) allowed from cluster nodes
- All cluster nodes can read/write to the filesystem

## Usage

### Job Script Example

```bash
#!/bin/bash
#SBATCH --job-name=my-job
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=16
#SBATCH --partition=main-queue
#SBATCH --output=/fsx/jobs/%j/output.log
#SBATCH --error=/fsx/jobs/%j/error.log

# Create job directory on FSx
JOB_DIR="/fsx/jobs/$SLURM_JOB_ID"
mkdir -p "$JOB_DIR"
cd "$JOB_DIR"

# Run your simulation
echo "Running simulation..."
./my_simulation > results.txt

# Results are automatically on FSx
# To sync to S3, add:
aws s3 sync "$JOB_DIR" s3://YOUR-BUCKET/hpc-jobs/$SLURM_JOB_ID/
```

### Lambda Job Submission

The Lambda function automatically sets the working directory to `/fsx/jobs/{timestamp}`:

```typescript
const jobSubmission = {
  job: {
    name: 'my-job',
    partition: 'main-queue',
    nodes: '1',
    tasks: 16,
    script: jobScript,
    current_working_directory: `/fsx/jobs/${Date.now()}`,
    environment: ['PATH=/usr/local/bin:/usr/bin:/bin']
  }
};
```

## Syncing Results to S3

### Automatic Sync (Built-in)

FSx for Lustre is configured with automatic S3 sync:

```typescript
// Configuration in parallelClusterRealTime.ts
lustreConfiguration: {
  deploymentType: 'PERSISTENT_1',
  perUnitStorageThroughput: 50,
  dataCompressionType: 'LZ4',
  importPath: `s3://${storageBucket.bucketName}/cfd-simulations`,
  exportPath: `s3://${storageBucket.bucketName}/cfd-simulations`,
  autoImportPolicy: 'NEW_CHANGED',
}
```

**How it works:**
- Files written to `/fsx/` are automatically exported to S3
- Files in `s3://bucket/hpc-jobs/` are automatically visible in `/fsx/`
- Changes in S3 are automatically imported to FSx
- No manual sync commands needed in most cases

### Manual Sync (Optional)

For immediate sync, you can still use manual commands:

```bash
# Force export to S3
lfs hsm_archive /fsx/jobs/$SLURM_JOB_ID/results.txt

# Force import from S3
lfs hsm_restore /fsx/input/data.dat

# Or use AWS CLI
aws s3 sync /fsx/jobs/$SLURM_JOB_ID s3://YOUR-BUCKET/hpc-jobs/jobs/$SLURM_JOB_ID/
```

### Avoiding Circular Dependencies

The HPC cluster now lives in its own **`HpcStack`** (`cdk/lib/hpc-stack.ts`), which imports the VPC/security group via `Fn.importValue` and lets the construct create **its own** HPC S3 bucket. Because FSx and that bucket are created in the same construct/stack, `bucket.bucketName` resolves locally and `importPath`/`exportPath` reference it with no cross-stack token dependency:

```typescript
// cdk/lib/hpc-stack.ts
const parallelCluster = new RealTimeParallelCluster(this, 'ParallelCluster', {
  storageBucketName: 'PLACEHOLDER', // construct creates its own HPC bucket
  vpc,
  clusterSecurityGroup,
  customComputeAmiId: props.customComputeAmiId,
});
```

### Importing Data from S3

To import data from S3 to FSx:

```bash
# Option 1: Manual copy
aws s3 cp s3://YOUR-BUCKET/input/data.dat /fsx/input/

# Option 2: With DRA (after setup), files appear automatically
# Just access the file and it's imported on-demand
cat /fsx/input/data.dat
```

## Monitoring

### Check FSx Status

```bash
# Via AWS CLI
aws fsx describe-file-systems \
  --query 'FileSystems[?Tags[?Key==`Name` && Value==`hpc-lustre-fs`]]'

# Via AWS Console
# Navigate to FSx → File systems → hpc-lustre-fs
```

### Check Mount on Cluster Nodes

```bash
# SSH to a cluster node (via SSM)
df -h /fsx

# Check Lustre mount
mount | grep lustre
```

## Cost Optimization

### FSx for Lustre Costs

- **Storage**: ~$0.14/GB-month for PERSISTENT_1
- **1200 GiB**: ~$168/month
- **Throughput**: Included in storage cost (50 MB/s/TiB)

### Cost Comparison

| Storage Type | Monthly Cost | Throughput | Use Case |
|--------------|--------------|------------|----------|
| EFS Standard | $0.30/GB | Bursting | General purpose |
| FSx PERSISTENT_1 | $0.14/GB | 50 MB/s/TiB | HPC workloads |
| FSx SCRATCH_2 | $0.10/GB | 200 MB/s/TiB | Temporary data |

### Recommendations

1. **For demo/testing**: Use EFS (pay per use, no minimum)
2. **For production HPC**: Use FSx PERSISTENT_1 (better performance)
3. **For temporary data**: Use FSx SCRATCH_2 (lowest cost, no persistence)

## Troubleshooting

### FSx Not Mounting

1. Check security group allows port 988
2. Verify FSx is in AVAILABLE state
3. Check cluster nodes have FSx mount configured

### Slow Performance

1. Check FSx throughput settings
2. Monitor FSx CloudWatch metrics
3. Consider increasing storage capacity (more capacity = more throughput)

### S3 Sync Issues

1. Verify IAM permissions for S3 access
2. Check S3 bucket exists and is accessible
3. Use `aws s3 ls` to test connectivity

## Next Steps

> Automatic S3 sync (import/export path + `autoImportPolicy: NEW_CHANGED`) is **already deployed** — it is no longer a next step.

1. **Add FSx Backup**: Automated backups to S3
2. **Add Monitoring**: CloudWatch dashboards for FSx metrics
3. **Add Lifecycle Policies**: Automatic data archival

## References

- [FSx for Lustre Documentation](https://docs.aws.amazon.com/fsx/latest/LustreGuide/)
- [AWS PCS Documentation](https://docs.aws.amazon.com/pcs/latest/userguide/)
- [Lustre File System](http://lustre.org/)
