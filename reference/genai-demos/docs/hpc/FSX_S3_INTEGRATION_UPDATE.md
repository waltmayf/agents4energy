# FSx for Lustre S3 Integration Update

> **Historical change-log, corrected.** This recorded the change while it was pending. It is now **deployed**. Two corrections vs the text below: (1) the S3 import/export path is **`s3://<bucket>/cfd-simulations`**, not `hpc-jobs/`; (2) the HPC construct now lives in its own **`HpcStack`** (`cdk/lib/hpc-stack.ts`) that imports the VPC and creates its own HPC bucket — not in the Amplify storage stack via `backend.ts`. See [README.md](README.md).

## Summary

Successfully configured FSx for Lustre with automatic S3 integration by moving the HPC construct to the storage stack, eliminating CloudFormation circular dependencies.

## Changes Made

### 1. HPC Construct Location (amplify/backend.ts)

Moved HPC construct instantiation to the storage stack:

```typescript
// Line 187 - Now in backend.storage.stack instead of backend.stack
const hpcConstruct = new HpcConstruct(backend.storage.stack, 'HpcParallelCluster', {
  storageBucket: backend.storage.resources.bucket,
  storageBucketName: backend.storage.resources.bucket.bucketName, // Now safe to pass
  vpc: vpc,
});
```

**Why this works:**
- FSx and S3 bucket are now in the same CloudFormation stack (storage stack)
- No cross-stack token dependencies
- `bucket.bucketName` resolves within the same stack
- No circular dependency issues

### 2. FSx Configuration (amplify/custom/parallelClusterRealTime.ts)

Added S3 import/export paths to FSx configuration:

```typescript
const s3ImportPath = `s3://${storageBucket.bucketName}/cfd-simulations`;
const s3ExportPath = `s3://${storageBucket.bucketName}/cfd-simulations`;

this.fsxFileSystem = new fsx.CfnFileSystem(this, 'LustreFileSystem', {
  fileSystemType: 'LUSTRE',
  subnetIds: [clusterSubnetIds[0]],
  securityGroupIds: [fsxSecurityGroup.securityGroupId],
  storageCapacity: 1200,
  lustreConfiguration: {
    deploymentType: 'PERSISTENT_1',
    perUnitStorageThroughput: 50,
    dataCompressionType: 'LZ4',
    importPath: s3ImportPath,        // NEW: Import from S3
    exportPath: s3ExportPath,        // NEW: Export to S3
    autoImportPolicy: 'NEW_CHANGED', // NEW: Auto-import changes
  },
});
```

### 3. Documentation Updates

Updated `docs/hpc/FSX_LUSTRE_INTEGRATION.md` to reflect:
- Automatic S3 sync is now enabled
- How the circular dependency was avoided
- Simplified usage instructions (no manual sync needed)

## How It Works

### Automatic Sync Behavior

1. **Import**: Files in `s3://bucket/hpc-jobs/` automatically appear in `/fsx/`
2. **Export**: Files written to `/fsx/` automatically sync to S3
3. **Auto-Import**: New or changed files in S3 are automatically imported
4. **Lazy Loading**: Files are loaded from S3 on first access (not all at mount)

### Example Job Flow

```bash
#!/bin/bash
#SBATCH --job-name=my-job
#SBATCH --output=/fsx/jobs/%j/output.log

# Create job directory
JOB_DIR="/fsx/jobs/$SLURM_JOB_ID"
mkdir -p "$JOB_DIR"
cd "$JOB_DIR"

# Run simulation
./my_simulation > results.txt

# Results automatically sync to S3!
# No manual aws s3 sync needed
```

### Retrieving Results

From the test script or frontend:

```typescript
// Results are automatically in S3
const s3Key = `hpc-jobs/jobs/${jobId}/results.txt`;
const result = await s3Client.send(new GetObjectCommand({
  Bucket: bucketName,
  Key: s3Key
}));
```

## Deployment Status

### Current State

- **Code Changes**: ✅ Complete
- **Deployment**: ✅ Deployed
- **FSx Creation**: ✅ Deployed (1200 GB PERSISTENT_1, S3 import/export to `cfd-simulations`)

### Next Deployment

When you run `npm run sandbox`, the deployment will:

1. Create FSx for Lustre filesystem (10-15 minutes)
2. Configure S3 import/export paths
3. Mount FSx at `/fsx` on all cluster nodes
4. Enable automatic S3 sync

### Verification Steps

After deployment completes:

```bash
# 1. Check FSx filesystem status
aws fsx describe-file-systems \
  --query 'FileSystems[?Tags[?Key==`Name` && Value==`hpc-lustre-fs`]]' \
  --output table

# 2. Verify S3 integration
aws fsx describe-file-systems \
  --query 'FileSystems[0].LustreConfiguration.DataRepositoryConfiguration' \
  --output json

# 3. Test job submission
npm run hpc:test
```

## Benefits

### Before (Manual Sync)

```bash
# Job script had to manually sync
aws s3 sync /fsx/jobs/$SLURM_JOB_ID s3://bucket/hpc-jobs/
```

### After (Automatic Sync)

```bash
# No sync needed - automatic!
# Just write to /fsx and it appears in S3
```

### Cost Savings

- No need for Data Repository Association (DRA) setup
- No manual sync commands in job scripts
- Automatic import/export reduces data transfer time
- Lazy loading reduces storage costs

## Troubleshooting

### If FSx Doesn't Create

1. Check CloudFormation events:
   ```bash
   aws cloudformation describe-stack-events \
     --stack-name amplify-aichatbot-waltmayf-sandbox-1e9b4f522c-storage0EC3F24A-1UVCQJF57JR2C \
     --query 'StackEvents[?contains(LogicalResourceId, `Fsx`)]'
   ```

2. Check for circular dependency errors in CloudFormation

3. Verify HPC construct is in storage stack:
   ```bash
   aws cloudformation list-stack-resources \
     --stack-name amplify-aichatbot-waltmayf-sandbox-1e9b4f522c-storage0EC3F24A-1UVCQJF57JR2C \
     --query 'StackResourceSummaries[?contains(LogicalResourceId, `Hpc`)]'
   ```

### If S3 Sync Doesn't Work

1. Check FSx configuration:
   ```bash
   aws fsx describe-file-systems \
     --query 'FileSystems[0].LustreConfiguration.DataRepositoryConfiguration'
   ```

2. Verify IAM permissions for FSx to access S3

3. Check FSx CloudWatch logs for sync errors

## References

- [FSx for Lustre Data Repository](https://docs.aws.amazon.com/fsx/latest/LustreGuide/fsx-data-repositories.html)
- [Avoiding Circular Dependencies in CDK](https://docs.aws.amazon.com/cdk/v2/guide/resources.html#resources_referencing)
- [AWS PCS with FSx](https://docs.aws.amazon.com/pcs/latest/userguide/working-with-fsx.html)

## Next Steps

1. **Deploy**: Run `npm run sandbox` to deploy FSx with S3 integration
2. **Wait**: FSx creation takes 10-15 minutes
3. **Test**: Run `npm run hpc:test` to submit a test job
4. **Verify**: Check S3 for job results in `hpc-jobs/jobs/{jobId}/`
5. **Monitor**: Watch CloudWatch metrics for FSx performance

---

**Status**: Deployed
**Last Updated**: March 2, 2026 (doc corrected August 2026)
**Author**: AI Assistant
