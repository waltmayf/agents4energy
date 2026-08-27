import { defineFunction } from '@aws-amplify/backend';

/**
 * Slurm Job Submitter Lambda Function
 * 
 * Submits jobs to the PCS cluster via Slurm REST API as an alternative to SSM-based submission.
 * 
 * This function is deployed in the same VPC as the PCS cluster to access the private
 * Slurm REST API endpoint (10.0.x.x:6820). It handles JWT authentication and job submission.
 * 
 * VPC Configuration:
 * - Deployed in same VPC as PCS cluster
 * - Access to private Slurm REST API endpoint
 * - Security group allows outbound to cluster security group
 * 
 * Environment Variables:
 * - CLUSTER_NAME: PCS cluster name
 * - JWT_SECRET_ARN: ARN of Secrets Manager secret containing JWT signing key
 */
export const slurmJobSubmitter = defineFunction({
  name: 'slurm-job-submitter',
  entry: './submitJob.ts',
  timeoutSeconds: 30,
  memoryMB: 256,
  resourceGroupName: 'data',
});
