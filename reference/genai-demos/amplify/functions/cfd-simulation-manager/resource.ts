import { defineFunction } from '@aws-amplify/backend';

/**
 * CFD Simulation Manager Lambda Functions
 * 
 * These functions manage the lifecycle of individual CFD simulations including
 * submission, monitoring, result parsing, and optimization metric calculation.
 * 
 * Supports both continuous optimization simulations and one-shot what-if scenarios.
 */

/**
 * Submit a CFD simulation job to the PCS cluster
 * 
 * Validates input parameters, generates Slurm batch script, submits job via SSM,
 * and creates CFDSimulation record in DynamoDB.
 * 
 * Environment Variables:
 * - STORAGE_BUCKET: S3 bucket name (resolved at runtime via SDK)
 * - HEAD_NODE_TAG: EC2 tag to identify login node
 * - CLUSTER_NAME: PCS cluster name
 */
export const submitCfdSimulation = defineFunction({
  name: 'submit-cfd-simulation',
  entry: './submitCfdSimulation.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Query the status of a CFD simulation job
 * 
 * Queries Slurm via SSM SendCommand to retrieve job state, maps to status enum,
 * and returns status-specific fields (elapsed time, S3 paths, error logs).
 * 
 * Environment Variables:
 * - HEAD_NODE_TAG: EC2 tag to identify login node
 * - CLUSTER_NAME: PCS cluster name
 */
export const getCfdJobStatus = defineFunction({
  name: 'get-cfd-job-status',
  entry: './getCfdJobStatus.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Retrieve and parse CFD simulation results
 * 
 * Downloads result files from S3, parses VTK/CSV/JSON formats, calculates
 * optimization metrics (proppant placement efficiency, fracture geometry score),
 * calculates risk metrics (screen-out risk), and generates recommendations.
 * 
 * Environment Variables:
 * - STORAGE_BUCKET: S3 bucket name (resolved at runtime via SDK)
 */
export const getCfdResults = defineFunction({
  name: 'get-cfd-results',
  entry: './getCfdResults.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Get CFD simulation status from DynamoDB
 * 
 * Retrieves the current status, progress, and metadata of a CFD simulation
 * from the CFDSimulation model in DynamoDB.
 * 
 * Environment Variables: None required
 */
export const getCfdSimulationStatus = defineFunction({
  name: 'get-cfd-simulation-status',
  entry: './getCfdSimulationStatus.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Cancel a running CFD simulation
 * 
 * Sends scancel command to Slurm via SSM, updates CFDSimulation status to CANCELLED,
 * and cleans up partial result files from S3.
 * 
 * Environment Variables:
 * - HEAD_NODE_TAG: EC2 tag to identify login node
 * - STORAGE_BUCKET: S3 bucket name (resolved at runtime via SDK)
 */
export const cancelCfdSimulation = defineFunction({
  name: 'cancel-cfd-simulation',
  entry: './cancelCfdSimulation.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Generate visualization snapshots from CFD results
 * 
 * Retrieves VTK files from S3, generates visualization images for specified time steps,
 * uploads images to S3, and creates SimulationSnapshot records in DynamoDB.
 * 
 * Environment Variables:
 * - STORAGE_BUCKET: S3 bucket name (resolved at runtime via SDK)
 */
export const generateSimulationSnapshots = defineFunction({
  name: 'generate-simulation-snapshots',
  entry: './generateSimulationSnapshots.ts',
  timeoutSeconds: 300,
  memoryMB: 1024,
  resourceGroupName: 'data',
});

/**
 * Cancel a CFD job (for optimization schema)
 * 
 * Sends scancel command to Slurm via SSM and updates job status to CANCELLED.
 * This is the handler for the optimization schema's cancelCfdJob mutation.
 * 
 * Environment Variables:
 * - HEAD_NODE_TAG: EC2 tag to identify login node
 */
export const cancelCfdJob = defineFunction({
  name: 'cancel-cfd-job',
  entry: './cancelCfdJob.ts',
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: 'data',
});

/**
 * Combined export for backend registration
 * 
 * This allows backend.ts to import all functions as a single object
 * while still maintaining individual exports for direct imports.
 */
export const cfdSimulationManager = {
  submitCfdSimulation,
  getCfdJobStatus,
  getCfdResults,
  getCfdSimulationStatus,
  cancelCfdSimulation,
  generateSimulationSnapshots,
  cancelCfdJob,
};
