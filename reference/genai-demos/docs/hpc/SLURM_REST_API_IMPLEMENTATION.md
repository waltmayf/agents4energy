# SLURM REST API Job Submission Implementation

> **Note:** This is the **alternate** submission path (VPC Lambda → SLURM REST API + JWT), used by `scripts/hpc/submitJobViaLambda.ts`. The **production path used by the agent** is SSM → `sbatch` on the always-on login node (`amplify/functions/cfd-simulation-manager`). See [README.md](README.md).

## Overview

This document describes the implementation of programmatic job submission to the AWS PCS cluster using the SLURM REST API. This approach allows submitting jobs without needing compute nodes to be running, and automatically triggers cluster auto-scaling.

## Architecture

```
┌─────────────────┐
│  Job Submission │
│     Script      │
└────────┬────────┘
         │
         ├─1─> AWS Secrets Manager
         │     (Get JWT signing key)
         │
         ├─2─> Generate JWT Token
         │     (HMAC-SHA256)
         │
         └─3─> SLURM REST API
               http://<private-ip>:6820
               ┌──────────────────┐
               │  SLURM Controller│
               │   (slurmrestd)   │
               └────────┬─────────┘
                        │
                        ├─> Queue Job
                        │
                        └─> Trigger Auto-Scaling
                            ┌──────────────────┐
                            │  Compute Nodes   │
                            │  (hpc7g.4xlarge) │
                            └──────────────────┘
```

## Key Components

### 1. JWT Authentication

AWS PCS uses JWT (JSON Web Token) authentication for the SLURM REST API. The JWT must include:

**Required Claims:**
- `exp` - Expiration time (seconds since epoch)
- `iat` - Issued at time (seconds since epoch)
- `sun` - Username (SLURM user name)
- `uid` - POSIX user ID
- `gid` - POSIX group ID
- `id` - Additional identity properties:
  - `gecos` - User comment field
  - `dir` - Home directory
  - `shell` - Default shell
  - `gids` - Array of additional group IDs

**Signing:**
- Algorithm: HMAC-SHA256
- Key: Retrieved from AWS Secrets Manager (managed by AWS PCS)

### 2. SLURM REST API Endpoint

- **URL Format:** `http://<private-ip>:6820/slurm/v0.0.43/`
- **API Version:** v0.0.43 (for SLURM 25.05)
- **Network:** Private IP within VPC (requires VPC access)
- **Port:** 6820 (default for slurmrestd)

### 3. Job Submission Payload

```json
{
  "script": "<job-script-content>",
  "job": {
    "name": "job-name",
    "partition": "queue-name",
    "nodes": [1, 1],  // [min, max]
    "tasks": 16,
    "time_limit": 300,  // seconds
    "standard_output": "/tmp/job-%j.out",
    "standard_error": "/tmp/job-%j.err"
  }
}
```

## Implementation

### Files Created/Modified

1. **`scripts/hpc/submitSampleJob.ts`**
   - Main job submission script
   - Retrieves JWT secret from Secrets Manager
   - Generates JWT token
   - Submits job via SLURM REST API
   - Handles errors and provides detailed feedback

2. **`scripts/hpc/README.md`**
   - Updated documentation
   - SLURM REST API usage guide
   - Troubleshooting tips

3. **`amplify/custom/backendOutputsConstruct.ts`**
   - Updated to note that JWT secret and endpoint are retrieved at runtime

4. **`package.json`**
   - Added `@aws-sdk/client-secrets-manager` dependency

### Runtime Flow

1. **Read Configuration**
   - Load cluster ID and region from `amplify_outputs.json`

2. **Get Cluster Details**
   - Call `GetClusterCommand` to retrieve cluster information
   - Extract JWT secret ARN from `scheduler.authenticationSecretArn`
   - Extract SLURM REST API endpoint from `endpoints` array (type: SLURMRESTD)

3. **Retrieve JWT Signing Key**
   - Call `GetSecretValueCommand` with the secret ARN
   - Decode base64-encoded secret value

4. **Generate JWT Token**
   - Create JWT header and payload
   - Sign with HMAC-SHA256 using the signing key
   - Encode as base64url

5. **Submit Job**
   - Read job script from `scripts/hpc/sample-job.sh`
   - Create job submission payload
   - POST to `/slurm/v0.0.43/job/submit`
   - Include JWT in `Authorization: Bearer <token>` header

6. **Handle Response**
   - Parse job ID from response
   - Display success message with next steps
   - Or display error details for troubleshooting

## Usage

### Prerequisites

- AWS credentials configured
- IAM permissions:
  - `pcs:GetCluster`
  - `secretsmanager:GetSecretValue`
- Network access to cluster VPC (for SLURM REST API)

### Running the Script

```bash
npm run hpc:submit-sample
```

### Expected Output

```
🚀 AWS PCS Sample Job Submission via SLURM REST API
====================================================
Cluster: openfoam-cluster (pcs_qc8nb2aww7)
Queue: main-queue (pcs_dbkykbzbn8)
Region: us-east-1

🔍 Retrieving cluster details...
✅ Cluster Status: ACTIVE
   Name: openfoam-cluster
   Scheduler: SLURM 25.05

🔑 JWT Secret ARN: arn:aws:secretsmanager:...
🌐 SLURM REST API: http://10.0.2.26:6820

🖥️  Checking compute node group status...
✅ Node Group: hpc7g-nodes
   Status: ACTIVE
   Scaling: 0 - 10 nodes

🔑 Retrieving JWT signing key from Secrets Manager...
✅ JWT signing key retrieved successfully
🔐 Generating JWT token for authentication...
✅ JWT token generated

📋 Job script loaded from: scripts/hpc/sample-job.sh

📤 Submitting job to SLURM REST API...
   Endpoint: http://10.0.2.26:6820
📋 Job configuration:
   Name: cfd-sample-test
   Partition: main-queue
   Nodes: 1
   Tasks: 16

✅ Job submitted successfully!
   Job ID: 123

✅ Job submitted successfully!

📊 What happens next:
   1. SLURM scheduler detects the pending job
   2. AWS PCS provisions compute nodes (5-10 minutes)
   3. Nodes register with SLURM and become available
   4. Job executes on the provisioned node
   5. After completion, nodes idle for 10 min (scaleDownIdleTimeInSeconds=600) then terminate

📝 Job ID: 123
```

## Advantages

### Over SSM-based Submission

1. **No Compute Nodes Required**
   - Can submit jobs when cluster is scaled to zero
   - No need to wait for nodes to provision before submitting

2. **Programmatic Access**
   - Pure HTTP API calls
   - No SSH or SSM session management
   - Easier to integrate into Lambda functions

3. **Immediate Submission**
   - Jobs enter the queue immediately
   - Auto-scaling triggers automatically
   - No manual intervention needed

4. **Better Error Handling**
   - Structured JSON responses
   - Clear error messages
   - HTTP status codes

### Cost Optimization

- Submit jobs when cluster is at zero nodes
- Only pay for compute when jobs are running
- No need to keep a head node or login node running

## Limitations

### Network Access

The SLURM REST API endpoint is on a private IP within the VPC. To access it:

**Option 1: Run from within VPC**
- EC2 instance in the same VPC
- Lambda function with VPC configuration
- Cloud9 environment

**Option 2: VPN/Bastion**
- Set up VPN connection to VPC
- Use bastion host with port forwarding

**Option 3: API Gateway + Lambda**
- Create Lambda function in VPC
- Expose via API Gateway
- Call from anywhere

### Authentication

- JWT tokens expire (default: 1 hour)
- Need AWS credentials to access Secrets Manager
- Signing key rotation requires updating tokens

## Troubleshooting

### "Failed to retrieve JWT signing key"

**Cause:** Missing IAM permissions

**Solution:**
```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:*:*:secret:pcs!*"
}
```

### "Connection refused" or "Network error"

**Cause:** No network access to VPC

**Solutions:**
1. Run script from EC2 instance in VPC
2. Set up VPN connection
3. Use Lambda function with VPC configuration

### "Job submission failed with errors"

**Common Causes:**
- Partition name doesn't match queue name
- Invalid job script syntax
- Resource limits exceeded
- Cluster not in ACTIVE state

**Debug Steps:**
1. Check cluster status: `aws pcs get-cluster --cluster-identifier <id>`
2. Verify queue name matches partition in job script
3. Check CloudWatch logs for detailed errors
4. Test with minimal job script

### "Cluster not in ACTIVE state"

**Cause:** Cluster still provisioning

**Solution:** Wait for cluster to reach ACTIVE state (5-10 minutes after deployment)

## Future Enhancements

1. **Job Status Monitoring**
   - Implement GET `/slurm/v0.0.43/job/<job-id>` endpoint
   - Poll for job completion
   - Stream job output

2. **Lambda Integration**
   - Create Lambda function for job submission
   - Deploy in VPC for network access
   - Expose via API Gateway

3. **Job Templates**
   - Pre-defined job configurations
   - Parameter substitution
   - Validation

4. **S3 Integration**
   - Automatic input data sync
   - Output data upload
   - Job artifacts management

5. **CloudWatch Integration**
   - Job metrics
   - Failure alarms
   - Cost tracking

## References

- [AWS PCS SLURM REST API Authentication](https://docs.aws.amazon.com/pcs/latest/userguide/slurm-rest-api-authenticate.html)
- [SLURM REST API Documentation](https://slurm.schedmd.com/rest.html)
- [SLURM REST API Quick Start](https://slurm.schedmd.com/rest_quickstart.html)
- [JWT RFC 7519](https://tools.ietf.org/html/rfc7519)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)

## Conclusion

The SLURM REST API provides a robust, programmatic way to submit jobs to AWS PCS clusters. By leveraging JWT authentication and HTTP APIs, we can submit jobs without needing compute nodes running, automatically trigger auto-scaling, and integrate seamlessly with AWS services.

This implementation provides a foundation for building production-grade CFD simulation workflows with AWS PCS.
